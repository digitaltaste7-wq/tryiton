// TryOn -> Vertex AI bridge. Runs inside Google Cloud, so it logs in automatically (no keys needed).
const functions = require('@google-cloud/functions-framework');
const MD = 'http://metadata.google.internal/computeMetadata/v1';
let tok = { value: '', exp: 0 }, project = '';

async function meta(path) {
  const r = await fetch(MD + path, { headers: { 'Metadata-Flavor': 'Google' } });
  return r;
}
async function token() {
  if (tok.value && tok.exp > Date.now() + 60000) return tok.value;
  const j = await (await meta('/instance/service-accounts/default/token')).json();
  tok = { value: j.access_token, exp: Date.now() + j.expires_in * 1000 };
  return tok.value;
}

functions.http('vertex', async (req, res) => {
  try {
    if (req.method !== 'POST') return res.status(200).send('TryOn bridge is running');
    if (!process.env.PROXY_KEY || req.get('x-proxy-key') !== process.env.PROXY_KEY) return res.status(401).json({ error: { message: 'Wrong proxy key' } });
    const { model, body, location } = req.body || {};
    if (!/^[\w.-]+$/.test(model || '') || !body) return res.status(400).json({ error: { message: 'Bad request' } });
    if (!project) project = await (await meta('/project/project-id')).text();
    const loc = /^[a-z0-9-]+$/.test(location || '') ? location : (process.env.LOCATION || 'global');
    const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
    const r = await fetch(`https://${host}/v1/projects/${project}/locations/${loc}/publishers/google/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + await token() },
      body: JSON.stringify(body),
    });
    res.status(r.status).type('application/json').send(await r.text());
  } catch (e) {
    res.status(500).json({ error: { message: 'Bridge error: ' + e.message } });
  }
});
