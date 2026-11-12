// Public endpoints only. Credentials belong on the server, never in the extension.
globalThis.RewardHarborConfig = {
  defaultApi: 'https://reward-harbor.onrender.com',
  storeOrigin(value) {
    try {
      const origin = new URL(value).origin;
      return ['https://reward-harbor.onrender.com', 'http://localhost:3000', 'http://127.0.0.1:3000'].includes(origin) ? origin : null;
    } catch { return null; }
  },
};
