/** Message names shared by the popup, the service worker and the content script. */
export const MSG = {
  PING: 'relist:ping',
  HELLO: 'relist:hello',
  LIST_ITEMS: 'relist:list-items',
  DIAGNOSE: 'relist:diagnose',
  RECORD_ENDPOINT: 'relist:record-endpoint',
  START: 'relist:start',
  CANCEL: 'relist:cancel',
  GET_STATE: 'relist:get-state',
  PROGRESS: 'relist:progress',
  FINISHED: 'relist:finished',
  RUN_SCHEDULED: 'relist:run-scheduled',
};

export const RUN_STATE_KEY = 'runState';

export const EMPTY_RUN_STATE = {
  active: false,
  startedAt: null,
  finishedAt: null,
  total: 0,
  done: 0,
  currentItemId: null,
  currentMessage: '',
  log: [],
  results: [],
  error: null,
  trigger: null,
};
