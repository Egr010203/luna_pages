import {
  createAssistant,
  createSmartappDebugger,
} from '@salutejs/client';

// Патчим WebSocket.send глобально ДО создания клиента.
// Если сокет уже закрыт — молча проглатываем ошибку.
// Это единственный надёжный способ подавить
// "WebSocket is already in CLOSING or CLOSED state"
// внутри @salutejs/client, не меняя библиотеку.
if (typeof window !== 'undefined' && !('__wsPatchApplied' in window)) {
  (window as any).__wsPatchApplied = true;
  const OriginalWebSocket = window.WebSocket;

  class PatchedWebSocket extends OriginalWebSocket {
    send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
      if (this.readyState === WebSocket.CLOSING || this.readyState === WebSocket.CLOSED) {
        // Молча игнорируем — библиотека сама откроет новое соединение
        return;
      }
      super.send(data);
    }
  }

  // @ts-ignore
  window.WebSocket = PatchedWebSocket;
}

let assistantInstance: any = null;
let getStateRef: (() => any) | null = null;

const listeners: Array<{ event: string; handler: (...args: any[]) => void }> = [];

const fallbackAssistant = {
  on: () => {},
  sendData: () => {},
};

const createInstance = (): any => {
  if (!getStateRef) return fallbackAssistant;

  try {
    if (import.meta.env.MODE === 'development') {
      return createSmartappDebugger({
        token: import.meta.env.VITE_SMARTAPP_TOKEN || '',
        initPhrase: `Запусти ${import.meta.env.VITE_SMARTAPP_NAME || 'смартапп'}`,
        getState: getStateRef,
        nativePanel: {
          defaultText: 'Говорите!',
          screenshotMode: false,
          tabIndex: -1,
          hideNativePanel: false,
        },
      });
    }
    return createAssistant({ getState: getStateRef });
  } catch (e) {
    console.error('[Assistant] Ошибка создания инстанса:', e);
    return fallbackAssistant;
  }
};

const reconnect = () => {
  console.log('[Assistant] Переподключение...');
  try {
    assistantInstance = createInstance();
    for (const { event, handler } of listeners) {
      assistantInstance.on(event, handler);
    }
    console.log('[Assistant] Переподключение успешно');
  } catch (e) {
    console.error('[Assistant] Переподключение не удалось:', e);
  }
};

const createProxy = (): any => ({
  on(event: string, handler: (...args: any[]) => void) {
    listeners.push({ event, handler });
    assistantInstance?.on(event, handler);
  },
  sendData(data: any) {
    try {
      assistantInstance?.sendData(data);
    } catch (e) {
      console.warn('[Assistant] sendData упал, переподключаемся:', e);
      reconnect();
    }
  },
});

let proxy: any = null;

export const initializeAssistant = (getState: () => any): any => {
  if (proxy) return proxy;
  getStateRef = getState;
  assistantInstance = createInstance();
  proxy = createProxy();
  return proxy;
};
