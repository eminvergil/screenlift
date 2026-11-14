// DLNA / UPnP TV support (Samsung, LG, Sony, Philips, Vestel… most smart TVs).
// Discovery uses SSDP (UDP 1900); playback is started with AVTransport SOAP actions.
const dgram = require('dgram');
const os = require('os');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;
const ST = 'urn:schemas-upnp-org:device:MediaRenderer:1';

function localIPv4s() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

function tag(xml, name) {
  const m = xml.match(new RegExp('<(?:\\w+:)?' + name + '[^>]*>([\\s\\S]*?)</(?:\\w+:)?' + name + '>', 'i'));
  return m ? decodeXml(m[1].trim()) : '';
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

async function describe(location) {
  const res = await fetch(location, { signal: AbortSignal.timeout(4000) });
  const xml = await res.text();
  const services = xml.match(/<(?:\w+:)?service>[\s\S]*?<\/(?:\w+:)?service>/gi) || [];
  const avt = services.find((s) => /AVTransport/i.test(tag(s, 'serviceType')));
  if (!avt) return null;
  const base = tag(xml, 'URLBase') || location;
  return {
    name: tag(xml, 'friendlyName') || 'TV',
    model: [tag(xml, 'manufacturer'), tag(xml, 'modelName')].filter(Boolean).join(' '),
    udn: tag(xml, 'UDN') || location,
    serviceType: tag(avt, 'serviceType'),
    controlURL: new URL(tag(avt, 'controlURL'), base).toString(),
  };
}

function discover(timeoutMs, onDevice) {
  return new Promise((resolve) => {
    const found = new Map();
    const seenLocations = new Set();
    const sockets = [];
    const msg = Buffer.from(
      'M-SEARCH * HTTP/1.1\r\n' +
        `HOST: ${SSDP_ADDR}:${SSDP_PORT}\r\n` +
        'MAN: "ssdp:discover"\r\n' +
        'MX: 2\r\n' +
        `ST: ${ST}\r\n\r\n`
    );

    const onMessage = (buf, rinfo) => {
      const m = buf.toString().match(/^location:\s*(.+)$/im);
      if (!m) return;
      const location = m[1].trim();
      if (seenLocations.has(location)) return;
      seenLocations.add(location);
      describe(location)
        .then((d) => {
          if (!d) return;
          const id = 'dlna:' + d.udn;
          if (found.has(id)) return;
          const dev = { id, kind: 'dlna', host: rinfo.address, ...d };
          found.set(id, dev);
          if (onDevice) onDevice(dev);
        })
        .catch(() => {});
    };

    // Send a separate search from each network interface (Wi-Fi + Ethernet may both be active).
    const addrs = localIPv4s();
    for (const addr of addrs.length ? addrs : ['0.0.0.0']) {
      const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sock.on('error', () => {});
      sock.on('message', onMessage);
      sock.bind(0, addr === '0.0.0.0' ? undefined : addr, () => {
        try {
          if (addr !== '0.0.0.0') sock.setMulticastInterface(addr);
          sock.send(msg, SSDP_PORT, SSDP_ADDR);
          setTimeout(() => sock.send(msg, SSDP_PORT, SSDP_ADDR), 600);
        } catch (e) { /* this interface is unusable */ }
      });
      sockets.push(sock);
    }

    setTimeout(() => {
      for (const s of sockets) {
        try { s.close(); } catch (e) { /* ignore */ }
      }
      // describe() requests may lag a bit; give them time too.
      setTimeout(() => resolve([...found.values()]), 1500);
    }, timeoutMs);
  });
}

async function soap(device, action, args) {
  const body =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${device.serviceType}">` +
    Object.entries(args)
      .map(([k, v]) => `<${k}>${escapeXml(v)}</${k}>`)
      .join('') +
    `</u:${action}></s:Body></s:Envelope>`;
  const res = await fetch(device.controlURL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: `"${device.serviceType}#${action}"`,
    },
    body,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) {
    const code = tag(text, 'errorCode');
    const desc = tag(text, 'errorDescription');
    throw new Error(`TV rejected the "${action}" command (${res.status}${code ? ' / ' + code : ''}${desc ? ' ' + desc : ''})`);
  }
  return text;
}

const PROTOCOL_INFO =
  'http-get:*:video/mpeg:DLNA.ORG_OP=00;DLNA.ORG_CI=0;DLNA.ORG_FLAGS=01700000000000000000000000000000';

async function play(device, url, title) {
  const didl =
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" ' +
    'xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/" xmlns:dlna="urn:schemas-dlna-org:metadata-1-0/">' +
    `<item id="0" parentID="-1" restricted="1"><dc:title>${escapeXml(title)}</dc:title>` +
    '<upnp:class>object.item.videoItem</upnp:class>' +
    `<res protocolInfo="${PROTOCOL_INFO}">${escapeXml(url)}</res></item></DIDL-Lite>`;
  await soap(device, 'Stop', { InstanceID: 0 }).catch(() => {});
  await soap(device, 'SetAVTransportURI', { InstanceID: 0, CurrentURI: url, CurrentURIMetaData: didl });
  try {
    await soap(device, 'Play', { InstanceID: 0, Speed: 1 });
  } catch (e) {
    // Some TVs return a "transitioning" error right after the URI is set; retry once.
    await new Promise((r) => setTimeout(r, 1200));
    await soap(device, 'Play', { InstanceID: 0, Speed: 1 });
  }
}

async function stop(device) {
  await soap(device, 'Stop', { InstanceID: 0 }).catch(() => {});
}

module.exports = { discover, play, stop, localIPv4s };
