type DOM = {
  type: 'text',
  text: string
} | {
  type: 'leaf',
  attrs: { [key: string]: string | null },
  element: string,
  namespace: string | null
} | {
  type: 'node',
  attrs: { [key: string]: string | null },
  element: string,
  namespace: string | null,
  children: DOM[]
};

type Value = string | boolean | null | { [key: string]: Value };

type AttrDiff = {
  type: 'delete',
  key: string
} | {
  type: 'insert',
  key: string,
  value: Value
} | {
  type: 'diff',
  key: string,
  diff: ValueDiff[]
};

type ValueDiff = {
  type: 'replace',
  value: Value
} | {
  type: 'diff',
  diff: AttrDiff[]
};

type Diff = {
  type: 'delete',
  index: number
} | {
  type: 'insert',
  index: number,
  dom: DOM
} | {
  type: 'diff',
  index: number,
  adiff: AttrDiff[],
  diff: Diff[]
} | {
  type: 'replace_text',
  index: number,
  text: string
};

type Update = {
  type: 'replace',
  dom: DOM[]
} | {
  type: 'update',
  serverFrame: number,
  clientFrame: number | null,
  diff: Diff[]
} | {
  type: 'call',
  arg: any,
  js: string
};

const MAX_FRAMES = 20;
let serverFrame = 0;
let clientFrame: number | null = null;

function addFrame(element: Element, frame: number, attr: string, frameData: any) {
  const frames = JSON.parse((element as any).dataset[attr] || "[]") as any[];

  frames.push([frame, frameData]);

  while (frames.length > MAX_FRAMES) {
    frames.shift();
  }

  (element as any).dataset[attr] = JSON.stringify(frames);
}

function getFrame(element: Element, attr: string, frame: number): string[] {
  const frames = JSON.parse((element as any).dataset[attr] || "[]") as any[];
  const result = [];

  for (const [f, d] of frames) {
    if (f === frame) {
      result.push(d);
    }
  }

  return result;
}

function clearFrames(element: Element, attr: string) {
  (element as any).dataset[attr] = '[]';
}

function patch(ws: WebSocket, serverFrame: number, diffs: Diff[], parent: Element) {
  for (const diff of diffs) {
    switch (diff.type) {
      case 'delete':
        parent.removeChild(parent.childNodes[diff.index]);
        break;

      case 'insert':
        buildDOM(ws, diff.dom, diff.index, parent);
        break;

      case 'diff':
        const element: Element = parent.childNodes[diff.index] as Element;

        for (const adiff of diff.adiff) {
          patchAttribute(ws, element, false, adiff);
        }

        patch(ws, serverFrame, diff.diff, element);

        break;

      case 'replace_text':
        const text: Node = parent.childNodes[diff.index] as Node;
        text.nodeValue = diff.text;
        break;
    }
  }
}

// https://stackoverflow.com/a/34519193
function stringifyEvent(e: any) {
  const obj: any = {};

  for (let k in e) {
    if (k === 'originalTarget') {
      continue;
    }

    obj[k] = e[k];
  }

  return JSON.stringify(obj, (_, v) => {
    if (v instanceof Node) return { value: (v as any).value };
    if (v instanceof Window) return 'Window';

    return v;
  }, ' ');
}

// https://stackoverflow.com/a/27521511
function getElementIndex(el: any): number {
    for (var i = 0; el = el.previousSibling; i++);
    return i;
}

function getElementPath(el: Element): number[] {
  const path = [];

  while (el !== document.body) {
    path.unshift(getElementIndex(el));
    el = (el as any).parentElement;
  }

  path.shift();

  return path;
}

const listeners: Map<Element, Map<string, EventListener>> = new Map();

function setEventListener(ws: WebSocket, element: Element, name: string) {
  const eventName = name.substring(2).toLowerCase();

  const listener = (event: any) => {
    const msg = {
      type: 'event',
      eventType: name,
      event: JSON.parse(stringifyEvent(event)),
      path: getElementPath(element),
      clientFrame: serverFrame,
    };

    if (eventName === 'input') {
      addFrame(element, serverFrame, 'value', (event.target as any).value);
    }

    ws.send(JSON.stringify(msg));
  }

  if(name == 'onFileLoad'){
    element.addEventListener('input', (event: any) => {
      const fileElement = element as HTMLInputElement;
      if(fileElement.files){
        const file = fileElement.files[0];
        if(file){
          const reader = new FileReader();
          reader.addEventListener('load', (event: any) => {
            listener({name: file.name, content: reader.result});
          }, false);
          reader.readAsDataURL(file);
        }
      }
    });
  }else{
    element.addEventListener(eventName, listener);
  }

  const elementListeners = listeners.get(element);

  if (elementListeners === undefined) {
    listeners.set(element, new Map([[name, listener]]));
  }
  else {
    elementListeners.set(name, listener);
  }
}

function setAttribute(ws: WebSocket, element: any, onProp: boolean, attr: string, value: any) {
  if (onProp) {
    element[attr] = value;
  }
  else {
    if (attr.startsWith('on')) {
      setEventListener(ws, element, attr);
    }
    else if (value !== null) {
      if (attr === 'value') {
        // We do simple client side prediction here: we check whether the server
        // value matches any of the client values for that server frame, and if it
        // does, we do nothing (i.e. we don't update the client value).

        // To be more accurate, we should keep track of the last client value we
        // looked at and only compare subsequent values.

        // In case the values don't match (i.e. the server cleared an input element)
        // we just replace the current value, loosing all subsequent edits as an
        // effect. In order to keep them we'd need to compute a diff between the
        // old server value and the subsequent client edits and apply the patches
        // to the new server value.

        // Currently, we'd encounter inconsistencies in some very rare edge cases
        // (with *very high lag* present). Imagine an input and text elements
        // showing the same value, but the input value is cleared on some special
        // text sequence (e.g. when the user types 'delete'):

        // Input element |  Server value  |  Text element |

        // [dele    ]       'dele'           'dele'           // initial (synced) state

        // [delet   ]       'dele'           'dele'           // user types 't'
        // [delet   ]       'delet'          'dele'           // 'delet' received on server
        // [delet   ]       'delet'          'delet'          // 'delet' synced to client

        // [delete  ]       'delet'          'delet'          // user types 'e'
        // [delete1 ]       'delet'          'delet'          // user types '1'
        // [delete12]       'delet'          'delet'          // user types '2'
        // [delete12]       ''               'delet'          // server receives 'delete', clears value
        // []               ''               ''               // '' synced to client
        // []               'delete1'        ''               // 'delete1' received on server
        // [3]              'delete1'        'delete1'        // user types '3'
        // [delete1]        'delete1'        'delete1'        // 'delete1' synced to client
        // [delete1]        'delete12'       'delete1'        // 'delete12' received on server
        // [delete12]       'delete12'       'delete12'       // 'delete12' synced to client
        // [delete12]       '3'              'delete12'       // '3' received on server
        // [3]              '3'              '3'              // '3' synced to client

        // So the user types 'delete123' and the input field oscillates between the
        // values ..., 'delete', 'delete1', 'delete12', '', '3', 'delete1',
        // 'delete12' and finally '3'. Still, eventual consistency is kept between
        // the input and text elements.

        // Under normal circumstances (i.e. ~50ms lag) this will behave as expected.

        // "Not great, not terrible..."
        // - Anatoly Dyatlov, deputy chief-engineer of the Chernobyl Nuclear Power Plant

        const frameData = clientFrame !== null ? getFrame(element, attr, clientFrame) : [];

        if (!frameData.includes(value)) {
          element.value = value;
          clearFrames(element, attr);
        }
      }
      else if (value === true) {
        element.setAttribute(attr, "");
      }
      else if (value === false) {
        element.removeAttribute(attr);
      }
      else if (typeof value === 'string') {
        element.setAttribute(attr, value);
      }
      else if (typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          setAttribute(ws, element[attr], true, k, v);
        }
      }
    }

    if (attr === 'autofocus') {
      setTimeout(() => element.focus(), 0);
    }
  }
}

function removeAttribute(element: any, onProp: boolean, attr: string) {
  if (onProp) {
    if (element.removeProperty) {
      element.removeProperty(attr);
    }
    else {
      element[attr] = '';
    }
  }
  else {
    if (attr.startsWith('on')) {
      const m = listeners.get(element);

      if (m !== undefined) {
        const eventName = attr.substring(2).toLowerCase();
        element.removeEventListener(eventName, m.get(attr));

        m.delete(attr);

        if (m.size === 0) {
          listeners.delete(element);
        }
      }
    }
    else {
      element.removeAttribute(attr);
    }
  }
}

function patchAttribute(ws: WebSocket, element: any, onProp: boolean, adiff: AttrDiff) {
  switch (adiff.type) {
    case 'insert':
      setAttribute(ws, element, onProp, adiff.key, adiff.value);
      break;

    case 'delete':
      removeAttribute(element, onProp, adiff.key);
      break;

    case 'diff':
      for (const vdiff of adiff.diff) {
        switch (vdiff.type) {
          case 'replace':
            setAttribute(ws, element, onProp, adiff.key, vdiff.value);
            break;

          case 'diff':
            const prop = element[adiff.key];

            for (const cdiff of vdiff.diff) {
              patchAttribute(ws, prop, true, cdiff);
            }
        }
      }
  }
}

function buildDOM(ws: WebSocket, dom: DOM, index: number | null, parent: Element): Element {
  let element = null;

  switch (dom.type) {
    case 'text':
      element = document.createTextNode(dom.text);
      break;

    case 'leaf':
      element = dom.namespace ? document.createElementNS(dom.namespace, dom.element) : document.createElement(dom.element);

      for (const [key, value] of Object.entries(dom.attrs)) {
        patchAttribute(ws, element, false, { type: 'insert', key, value });
      }

      break;

    case 'node':
      element = dom.namespace ? document.createElementNS(dom.namespace, dom.element) : document.createElement(dom.element);

      for (let i = 0; i < dom.children.length; i++) {
        buildDOM(ws, dom.children[i], null, element);
      }

      for (const [key, value] of Object.entries(dom.attrs)) {
        patchAttribute(ws, element, false, { type: 'insert', key, value });
      }

      break;
  }

  if (element !== null) {
    if (index === null) {
      parent.appendChild(element);
    }
    else {
      parent.insertBefore(element, parent.childNodes[index]);
    }
  }

  return element as any;
}

// Reference:
// https://developer.mozilla.org/en-US/docs/Web/API/CloseEvent
// https://tools.ietf.org/html/rfc6455#section-7.4
const CLOSE_CODE_NORMAL_CLOSURE = 1000
const CLOSE_CODE_INTERNAL_ERROR = 1011

function connect() {
  let root = document.createElement('div');

  const port = window.location.port ? window.location.port : (window.location.protocol === 'http:' ? 80 : 443);
  const wsProtocol = window.location.protocol === 'http:' ? 'ws:' : 'wss:';
  const ws = new WebSocket(wsProtocol + "//" + window.location.hostname + ":" + port + window.location.pathname);

  document.body.appendChild(root);

  (window as any)['callCallback'] = (cbId: number, arg: any) => {
    const msg = {
      type: 'call',
      arg,
      id: cbId
    };

    ws.send(JSON.stringify(msg));
  };

  ws.onmessage = (event) => {
    const update: Update = JSON.parse(event.data);

    switch (update.type) {
      case 'replace':
        if (root !== null) {
          document.body.removeChild(root);
          root = document.createElement('div');
          document.body.appendChild(root);
        }

        for (const element of update.dom) {
          buildDOM(ws, element, null, root);
        }

        break;

      case 'update':
        if (root !== null) {
          serverFrame = update.serverFrame;
          clientFrame = update.clientFrame;

          patch(ws, update.serverFrame, update.diff, root);
        }

        break;

      case 'call':
        const f = new Function("arg", update.js);
        f(update.arg);
        break;
    }
  };

  ws.onclose = (event) => {
    switch (event.code) {
      case CLOSE_CODE_NORMAL_CLOSURE:
        // Server-side gracefully ended.
        break;
      case CLOSE_CODE_INTERNAL_ERROR:
        // Error occured on server-side.
        alert("Internal server error, please reload the page: " + event.reason);
        break;
      default:
        // Other reasons. Some of them could be worth trying re-connecting.
    }
  };
}

connect();
