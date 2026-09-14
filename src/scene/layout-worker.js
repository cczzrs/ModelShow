import { createLayout } from './layout.js';
self.onmessage = ({data}) => {
  try { self.postMessage({result:createLayout(data.model,data.mode)}); }
  catch(error) { self.postMessage({error:error.message}); }
};
