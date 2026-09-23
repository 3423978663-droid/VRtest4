// Netlify Function：能力信息。
exports.handler = async (event) => {
  const host = event && event.headers && event.headers.host;
  const origin = process.env.URL || (host ? 'https://' + host : '');
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      origin,
      features: { qrUpload: true, onlineDict: true },
    }),
  };
};
