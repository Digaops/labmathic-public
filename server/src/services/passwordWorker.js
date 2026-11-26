const { parentPort } = require('node:worker_threads');
const bcrypt = require('bcryptjs');

// Only CPU work runs here: no database, configuration, tokens or logging.
parentPort.on('message', ({ operation, password, value }) => {
  try {
    const result = operation === 'hash'
      ? bcrypt.hashSync(password, value)
      : bcrypt.compareSync(password, value);
    parentPort.postMessage({ result });
  } catch {
    parentPort.postMessage({ failed: true });
  }
});
