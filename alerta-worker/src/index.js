var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// node_modules/base64-arraybuffer/dist/base64-arraybuffer.es5.js
var chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
var lookup = typeof Uint8Array === "undefined" ? [] : new Uint8Array(256);
for (i = 0; i < chars.length; i++) {
  lookup[chars.charCodeAt(i)] = i;
}
var i;
var encode = /* @__PURE__ */ __name(function(arraybuffer) {
  var bytes = new Uint8Array(arraybuffer), i2, len = bytes.length, base64 = "";
  for (i2 = 0; i2 < len; i2 += 3) {
    base64 += chars[bytes[i2] >> 2];
    base64 += chars[(bytes[i2] & 3) << 4 | bytes[i2 + 1] >> 4];
    base64 += chars[(bytes[i2 + 1] & 15) << 2 | bytes[i2 + 2] >> 6];
    base64 += chars[bytes[i2 + 2] & 63];
  }
  if (len % 3 === 2) {
    base64 = base64.substring(0, base64.length - 1) + "=";
  } else if (len % 3 === 1) {
    base64 = base64.substring(0, base64.length - 2) + "==";
  }
  return base64;
}, "encode");
var decode = /* @__PURE__ */ __name(function(base64) {
  var bufferLength = base64.length * 0.75, len = base64.length, i2, p = 0, encoded1, encoded2, encoded3, encoded4;
  if (base64[base64.length - 1] === "=") {
    bufferLength--;
    if (base64[base64.length - 2] === "=") {
      bufferLength--;
    }
  }
  var arraybuffer = new ArrayBuffer(bufferLength), bytes = new Uint8Array(arraybuffer);
  for (i2 = 0; i2 < len; i2 += 4) {
    encoded1 = lookup[base64.charCodeAt(i2)];
    encoded2 = lookup[base64.charCodeAt(i2 + 1)];
    encoded3 = lookup[base64.charCodeAt(i2 + 2)];
    encoded4 = lookup[base64.charCodeAt(i2 + 3)];
    bytes[p++] = encoded1 << 2 | encoded2 >> 4;
    bytes[p++] = (encoded2 & 15) << 4 | encoded3 >> 2;
    bytes[p++] = (encoded3 & 3) << 6 | encoded4 & 63;
  }
  return arraybuffer;
}, "decode");

// node_modules/@block65/webcrypto-web-push/dist/lib/cf-jwt/base64.js
function decodeBase64Url(str) {
  return decode(str.replace(/-/g, "+").replace(/_/g, "/"));
}
__name(decodeBase64Url, "decodeBase64Url");
function encodeBase64Url(arr) {
  return encode(arr).replace(/\//g, "_").replace(/\+/g, "-").replace(/=+$/, "");
}
__name(encodeBase64Url, "encodeBase64Url");
function objectToBase64Url(obj) {
  return encodeBase64Url(new TextEncoder().encode(JSON.stringify(obj)));
}
__name(objectToBase64Url, "objectToBase64Url");

// node_modules/@block65/webcrypto-web-push/dist/lib/isomorphic-crypto.js
var impl = globalThis.crypto ? globalThis.crypto : await import("node:crypto");
var crypto2 = {
  getRandomValues: /* @__PURE__ */ __name((array) => "webcrypto" in impl ? impl.webcrypto.getRandomValues(array) : impl.getRandomValues(array), "getRandomValues"),
  subtle: "webcrypto" in impl ? impl.webcrypto.subtle : impl.subtle
};
var CryptoKey2 = "webcrypto" in impl ? impl.webcrypto.CryptoKey : globalThis.CryptoKey;

// node_modules/@block65/webcrypto-web-push/dist/lib/client-keys.js
async function deriveClientKeys(sub) {
  const publicBytes = decodeBase64Url(sub.keys.p256dh);
  const publicJwk = {
    kty: "EC",
    crv: "P-256",
    x: encodeBase64Url(publicBytes.slice(1, 33)),
    y: encodeBase64Url(publicBytes.slice(33, 65)),
    ext: true
  };
  return {
    publicBytes: new Uint8Array(publicBytes),
    publicKey: await crypto2.subtle.importKey("jwk", publicJwk, {
      name: "ECDH",
      namedCurve: "P-256"
    }, true, []),
    authSecretBytes: decodeBase64Url(sub.keys.auth)
  };
}
__name(deriveClientKeys, "deriveClientKeys");

// node_modules/@block65/webcrypto-web-push/dist/lib/hkdf.js
function createHMAC(data) {
  if (data.byteLength === 0) {
    return {
      hash: /* @__PURE__ */ __name(() => Promise.resolve(new ArrayBuffer(32)), "hash")
    };
  }
  const keyPromise = crypto2.subtle.importKey("raw", data, {
    name: "HMAC",
    hash: "SHA-256"
  }, true, ["sign"]);
  return {
    hash: /* @__PURE__ */ __name(async (input) => {
      const k = await keyPromise;
      return crypto2.subtle.sign("HMAC", k, input);
    }, "hash")
  };
}
__name(createHMAC, "createHMAC");
async function hkdf(salt, ikm) {
  const prkhPromise = createHMAC(salt).hash(ikm).then((prk) => createHMAC(prk));
  return {
    extract: /* @__PURE__ */ __name(async (info, len) => {
      const input = new Uint8Array([
        ...new Uint8Array(info),
        ...new Uint8Array([1])
      ]);
      const prkh = await prkhPromise;
      const hash = await prkh.hash(input);
      return hash.slice(0, len);
    }, "extract")
  };
}
__name(hkdf, "hkdf");

// node_modules/@block65/webcrypto-web-push/dist/lib/utils.js
function flattenUint8Array(arrays) {
  const flatNumberArray = arrays.reduce((accum, arr) => {
    accum.push(...arr);
    return accum;
  }, []);
  return new Uint8Array(flatNumberArray);
}
__name(flattenUint8Array, "flattenUint8Array");
function be16(val) {
  return (val & 255) << 8 | val >> 8 & 255;
}
__name(be16, "be16");
function arrayChunk(arr, chunkSize) {
  const chunks = [];
  const arrayLength = arr.length;
  let i2 = 0;
  while (i2 < arrayLength) {
    chunks.push(arr.slice(i2, i2 += chunkSize));
  }
  return chunks;
}
__name(arrayChunk, "arrayChunk");
function generateNonce(base, index) {
  const nonce = base.slice(0, 12);
  for (let i2 = 0; i2 < 6; ++i2) {
    nonce[nonce.length - 1 - i2] ^= index / 256 ** i2 & 255;
  }
  return nonce;
}
__name(generateNonce, "generateNonce");
function encodeLength(int) {
  return new Uint8Array([0, int]);
}
__name(encodeLength, "encodeLength");
function invariant(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
__name(invariant, "invariant");

// node_modules/@block65/webcrypto-web-push/dist/lib/info.js
function createInfo(clientPublic, serverPublic, type) {
  return new Uint8Array([
    ...new TextEncoder().encode(`Content-Encoding: ${type}\0`),
    ...new TextEncoder().encode("P-256\0"),
    ...encodeLength(clientPublic.byteLength),
    ...clientPublic,
    ...encodeLength(serverPublic.byteLength),
    ...serverPublic
  ]);
}
__name(createInfo, "createInfo");
function createInfo2(type) {
  return new Uint8Array([
    ...new TextEncoder().encode(`Content-Encoding: ${type}\0`)
    // ...new TextEncoder().encode('P-256\0'),
    // ...encodeInt(clientPublic.byteLength),
    // ...clientPublic,
    // ...encodeInt(serverPublic.byteLength),
    // ...serverPublic,
  ]);
}
__name(createInfo2, "createInfo2");

// node_modules/@block65/webcrypto-web-push/dist/lib/jwk-to-bytes.js
function ecJwkToBytes(jwk) {
  invariant(jwk.x, "jwk.x is missing");
  invariant(jwk.y, "jwk.y is missing");
  const xBytes = new Uint8Array(decodeBase64Url(jwk.x));
  const yBytes = new Uint8Array(decodeBase64Url(jwk.y));
  const raw = [4, ...xBytes, ...yBytes];
  return new Uint8Array(raw);
}
__name(ecJwkToBytes, "ecJwkToBytes");

// node_modules/@block65/webcrypto-web-push/dist/lib/local-keys.js
async function generateLocalKeys() {
  const keyPair = await crypto2.subtle.generateKey({
    name: "ECDH",
    namedCurve: "P-256"
  }, true, ["deriveBits"]);
  const publicJwk = await crypto2.subtle.exportKey("jwk", keyPair.publicKey);
  const privateJwk = await crypto2.subtle.exportKey("jwk", keyPair.privateKey);
  return {
    publicKey: await crypto2.subtle.importKey("jwk", publicJwk, { name: "ECDH", namedCurve: "P-256" }, true, []),
    privateKey: keyPair.privateKey,
    publicJwk,
    privateJwk
  };
}
__name(generateLocalKeys, "generateLocalKeys");

// node_modules/@block65/webcrypto-web-push/dist/lib/salt.js
async function getSalt() {
  return crypto2.getRandomValues(new Uint8Array(16));
}
__name(getSalt, "getSalt");

// node_modules/@block65/webcrypto-web-push/dist/lib/encrypt.js
async function encryptNotification(subscription, plaintext) {
  const clientKeys = await deriveClientKeys(subscription);
  const salt = await getSalt();
  const localKeys = await generateLocalKeys();
  const localPublicKeyBytes = ecJwkToBytes(localKeys.publicJwk);
  const sharedSecret = await crypto2.subtle.deriveBits({
    name: "ECDH",
    // namedCurve: 'P-256',
    public: clientKeys.publicKey
  }, localKeys.privateKey, 256);
  const cekInfo = createInfo(clientKeys.publicBytes, localPublicKeyBytes, "aesgcm");
  const nonceInfo = createInfo(clientKeys.publicBytes, localPublicKeyBytes, "nonce");
  const keyInfo = createInfo2("auth");
  const ikmHkdf = await hkdf(clientKeys.authSecretBytes, sharedSecret);
  const ikm = await ikmHkdf.extract(keyInfo, 32);
  const messageHkdf = await hkdf(salt, ikm);
  const cekBytes = await messageHkdf.extract(cekInfo, 16);
  const nonceBytes = await messageHkdf.extract(nonceInfo, 12);
  const cekCryptoKey = await crypto2.subtle.importKey("raw", cekBytes, {
    name: "AES-GCM",
    length: 128
  }, false, ["encrypt"]);
  const cipherChunks = await Promise.all(arrayChunk(plaintext, 4095).map(async (chunk, idx) => {
    const padSize = 0;
    const x = new Uint16Array([be16(padSize)]);
    const padded = new Uint8Array([
      ...new Uint8Array(x.buffer, x.byteOffset, x.byteLength),
      ...chunk
    ]);
    const encrypted = await crypto2.subtle.encrypt({
      name: "AES-GCM",
      iv: generateNonce(new Uint8Array(nonceBytes), idx)
    }, cekCryptoKey, padded);
    return new Uint8Array(encrypted);
  }));
  return {
    ciphertext: flattenUint8Array(cipherChunks),
    salt,
    localPublicKeyBytes
  };
}
__name(encryptNotification, "encryptNotification");

// node_modules/@block65/webcrypto-web-push/dist/lib/cf-jwt/jwt-algorithms.js
var algorithms = {
  ES256: { name: "ECDSA", namedCurve: "P-256", hash: { name: "SHA-256" } },
  ES384: { name: "ECDSA", namedCurve: "P-384", hash: { name: "SHA-384" } },
  ES512: { name: "ECDSA", namedCurve: "P-521", hash: { name: "SHA-512" } },
  HS256: { name: "HMAC", hash: { name: "SHA-256" } },
  HS384: { name: "HMAC", hash: { name: "SHA-384" } },
  HS512: { name: "HMAC", hash: { name: "SHA-512" } },
  RS256: { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-256" } },
  RS384: { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-384" } },
  RS512: { name: "RSASSA-PKCS1-v1_5", hash: { name: "SHA-512" } }
};

// node_modules/@block65/webcrypto-web-push/dist/lib/cf-jwt/sign.js
async function sign(payload, key, options) {
  if (payload === null || typeof payload !== "object") {
    throw new Error("payload must be an object");
  }
  if (!(key instanceof CryptoKey2)) {
    throw new Error("key must be a CryptoKey");
  }
  if (typeof options.algorithm !== "string") {
    throw new Error("options.algorithm must be a string");
  }
  const headerStr = objectToBase64Url({
    typ: "JWT",
    alg: options.algorithm,
    ...options.kid && { kid: options.kid }
  });
  const payloadStr = objectToBase64Url({
    iat: Math.floor(Date.now() / 1e3),
    ...payload
  });
  const dataStr = `${headerStr}.${payloadStr}`;
  const signature = await crypto2.subtle.sign(algorithms[options.algorithm], key, new TextEncoder().encode(dataStr));
  return `${dataStr}.${encodeBase64Url(signature)}`;
}
__name(sign, "sign");

// node_modules/@block65/custom-error/dist/lib/custom-error.js
var Status;
(function(Status2) {
  Status2[Status2["OK"] = 0] = "OK";
  Status2[Status2["CANCELLED"] = 1] = "CANCELLED";
  Status2[Status2["UNKNOWN"] = 2] = "UNKNOWN";
  Status2[Status2["INVALID_ARGUMENT"] = 3] = "INVALID_ARGUMENT";
  Status2[Status2["DEADLINE_EXCEEDED"] = 4] = "DEADLINE_EXCEEDED";
  Status2[Status2["NOT_FOUND"] = 5] = "NOT_FOUND";
  Status2[Status2["ALREADY_EXISTS"] = 6] = "ALREADY_EXISTS";
  Status2[Status2["PERMISSION_DENIED"] = 7] = "PERMISSION_DENIED";
  Status2[Status2["RESOURCE_EXHAUSTED"] = 8] = "RESOURCE_EXHAUSTED";
  Status2[Status2["FAILED_PRECONDITION"] = 9] = "FAILED_PRECONDITION";
  Status2[Status2["ABORTED"] = 10] = "ABORTED";
  Status2[Status2["OUT_OF_RANGE"] = 11] = "OUT_OF_RANGE";
  Status2[Status2["UNIMPLEMENTED"] = 12] = "UNIMPLEMENTED";
  Status2[Status2["INTERNAL"] = 13] = "INTERNAL";
  Status2[Status2["UNAVAILABLE"] = 14] = "UNAVAILABLE";
  Status2[Status2["DATA_LOSS"] = 15] = "DATA_LOSS";
  Status2[Status2["UNAUTHENTICATED"] = 16] = "UNAUTHENTICATED";
})(Status || (Status = {}));
var CUSTOM_ERROR_SYM = /* @__PURE__ */ Symbol.for("CustomError");
var defaultHttpMapping = /* @__PURE__ */ new Map([
  [Status.OK, 200],
  [Status.INVALID_ARGUMENT, 400],
  [Status.FAILED_PRECONDITION, 400],
  [Status.OUT_OF_RANGE, 400],
  [Status.UNAUTHENTICATED, 401],
  [Status.PERMISSION_DENIED, 403],
  [Status.NOT_FOUND, 404],
  [Status.ABORTED, 409],
  [Status.ALREADY_EXISTS, 409],
  [Status.RESOURCE_EXHAUSTED, 403],
  [Status.CANCELLED, 499],
  [Status.DATA_LOSS, 500],
  [Status.UNKNOWN, 500],
  [Status.INTERNAL, 500],
  [Status.UNIMPLEMENTED, 501],
  // [Code.LOCAL_OUTAGE,  502],
  [Status.UNAVAILABLE, 503],
  [Status.DEADLINE_EXCEEDED, 504]
]);
function withNullProto(obj) {
  return Object.assign(/* @__PURE__ */ Object.create(null), obj);
}
__name(withNullProto, "withNullProto");
var CustomError = class _CustomError extends Error {
  static {
    __name(this, "CustomError");
  }
  /**
   * The previous error that occurred, useful if "wrapping" an error to hide
   * sensitive details
   * @type {Error | CustomError | unknown}
   */
  cause;
  /**
   * Further error details suitable for end user consumption
   * @type {ErrorDetail[]}
   */
  details;
  /**
   * Status code suitable to coarsely determine the reason for error
   * @type {Status}
   */
  code = Status.UNKNOWN;
  /**
   * Contains arbitrary debug data for developer troubleshooting
   * @type {DebugData}
   * @private
   */
  debugData;
  /**
   *
   * @param {string} message Developer facing message, in English.
   * @param {Error | CustomError | unknown} cause
   */
  constructor(message, cause) {
    super(message, { cause });
    this.cause = cause;
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
    Object.setPrototypeOf(this, new.target.prototype);
  }
  static isCustomError(value) {
    return !!value && typeof value === "object" && CUSTOM_ERROR_SYM in value;
  }
  debug(data) {
    if (arguments.length > 0) {
      this.debugData = withNullProto({
        ...this.debugData,
        ...data
      });
      return this;
    }
    return this.debugData;
  }
  /**
   * Human readable representation of the error code
   * @return {keyof typeof Status}
   */
  get status() {
    return Status[this.code];
  }
  /**
   * Adds further error details suitable for end user consumption
   * @param {ErrorDetail} details
   * @return {this}
   */
  addDetail(...details) {
    this.details = (this.details || []).concat(details);
    return this;
  }
  /**
   * A "safe" serialised version of the error designed for end user consumption
   * @return {CustomErrorSerialized}
   */
  serialize() {
    const localised = this.details?.find((detail) => "locale" in detail);
    return withNullProto({
      message: this.message,
      ...localised?.message && {
        message: localised.message
      },
      code: this.code,
      status: this.status,
      ...this.details && { details: this.details }
    });
  }
  /**
   * JSON representation of the error object.
   *
   * Use {serialize} instead if you need to send this error over the wire
   *
   * @return {object}
   */
  toJSON() {
    const debug = this.debug();
    return withNullProto({
      name: this.name,
      message: this.message,
      code: this.code,
      status: this.status,
      ...this.details && { details: this.details },
      ...this.cause instanceof Error && {
        cause: "toJSON" in this.cause && typeof this.cause.toJSON === "function" ? this.cause.toJSON() : {
          message: this.cause.message,
          name: "Error"
        }
      },
      ...this.stack && { stack: this.stack },
      ...debug && { debug }
    });
  }
  /**
   * "Hydrates" a previously serialised error object
   * @param {CustomErrorSerialized} params
   * @return {CustomError}
   */
  static fromJSON(params) {
    const { code = Status.UNKNOWN, message, details = [] } = params;
    const err = new _CustomError(message || (Status[params.code] || params.code || "Error").toString()).debug({ params });
    err.code = code;
    if (details) {
      err.addDetail(...details);
    }
    return err;
  }
  /**
   * An automatically determined HTTP status code
   * @return {number}
   */
  static suggestHttpResponseCode(err) {
    const code = _CustomError.isCustomError(err) ? err.code : Status.UNKNOWN;
    return defaultHttpMapping.get(code) || 500;
  }
};
Object.defineProperty(CustomError.prototype, CUSTOM_ERROR_SYM, {
  value: true,
  enumerable: false,
  writable: false
});
Object.defineProperty(CustomError.prototype, "status", {
  enumerable: true
});

// node_modules/@block65/webcrypto-web-push/dist/lib/vapid.js
async function vapidHeaders(subscription, vapid) {
  invariant(vapid.subject, "Vapid subject is empty");
  invariant(vapid.privateKey, "Vapid private key is empty");
  invariant(vapid.publicKey, "Vapid public key is empty");
  const vapidPublicKeyBytes = decodeBase64Url(vapid.publicKey);
  const publicKey = await crypto2.subtle.importKey("jwk", {
    kty: "EC",
    crv: "P-256",
    x: encodeBase64Url(vapidPublicKeyBytes.slice(1, 33)),
    y: encodeBase64Url(vapidPublicKeyBytes.slice(33, 65)),
    d: vapid.privateKey
  }, {
    name: "ECDSA",
    namedCurve: "P-256"
  }, false, ["sign"]);
  const jwt = await sign({
    aud: new URL(subscription.endpoint).origin,
    exp: Math.floor(Date.now() / 1e3) + 12 * 60 * 60,
    sub: vapid.subject
  }, publicKey, {
    algorithm: "ES256"
  });
  return {
    headers: {
      authorization: `WebPush ${jwt}`,
      "crypto-key": `p256ecdsa=${vapid.publicKey}`
    }
    // publicJwk,
  };
}
__name(vapidHeaders, "vapidHeaders");

// node_modules/@block65/webcrypto-web-push/dist/lib/payload.js
async function buildPushPayload(message, subscription, vapid) {
  const { headers } = await vapidHeaders(subscription, vapid);
  const encrypted = await encryptNotification(subscription, new TextEncoder().encode(
    // if its a primitive, convert to string, otherwise stringify
    typeof message.data === "string" || typeof message.data === "number" ? message.data.toString() : JSON.stringify(message.data)
  ));
  return {
    headers: {
      ...headers,
      "crypto-key": `dh=${encodeBase64Url(encrypted.localPublicKeyBytes)};${headers["crypto-key"]}`,
      encryption: `salt=${encodeBase64Url(encrypted.salt)}`,
      ttl: (message.options?.ttl || 60).toString(),
      ...message.options?.urgency && {
        urgency: message.options.urgency
      },
      ...message.options?.topic && {
        topic: message.options.topic
      },
      "content-encoding": "aesgcm",
      "content-length": encrypted.ciphertext.byteLength.toString(),
      "content-type": "application/octet-stream"
    },
    method: "post",
    body: encrypted.ciphertext
  };
}
__name(buildPushPayload, "buildPushPayload");

// src/index.js
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
  });
}
__name(json, "json");
function generateId() {
  return crypto.randomUUID();
}
__name(generateId, "generateId");
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
__name(sleep, "sleep");
function handleOptions() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type"
    }
  });
}
__name(handleOptions, "handleOptions");
var INDEX_KEY = "cron:index";
var STATES_KEY = "cron:states";
function subKey(id) {
  return "sub:" + id;
}
__name(subKey, "subKey");
function alertKey(id) {
  return "alert:" + id;
}
__name(alertKey, "alertKey");
function buildLevelsKey(support, resistance, direction) {
  return support + "|" + resistance + "|" + direction;
}
__name(buildLevelsKey, "buildLevelsKey");
var HYSTERESIS_PCT = 15e-4;
var COOLDOWN_MS = 3e5;
function safeTimestamp(ts) {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  return Number.isFinite(t) ? t : null;
}
__name(safeTimestamp, "safeTimestamp");
function freshState(levelsKey, lastPrice = null) {
  return {
    lastPrice,
    resistanceTriggered: false,
    supportTriggered: false,
    pendingResistance: null,
    pendingSupport: null,
    lastResistanceTriggeredAt: null,
    lastSupportTriggeredAt: null,
    levelsKey,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
}
__name(freshState, "freshState");
async function readIndex(env) {
  const raw = await env.ALERTAS_KV.get(INDEX_KEY);
  if (raw) return { index: JSON.parse(raw), isNew: false };
  return { index: { alerts: [], subs: [] }, isNew: true };
}
__name(readIndex, "readIndex");
async function writeIndex(env, index) {
  await env.ALERTAS_KV.put(INDEX_KEY, JSON.stringify(index));
}
__name(writeIndex, "writeIndex");
async function addSubToIndex(env, subId) {
  const { index } = await readIndex(env);
  if (!index.subs.includes(subId)) {
    index.subs.push(subId);
    await writeIndex(env, index);
  }
}
__name(addSubToIndex, "addSubToIndex");
async function removeSubFromIndex(env, subId) {
  const { index } = await readIndex(env);
  const i2 = index.subs.indexOf(subId);
  if (i2 !== -1) {
    index.subs.splice(i2, 1);
    await writeIndex(env, index);
  }
}
__name(removeSubFromIndex, "removeSubFromIndex");
async function addAlertToIndex(env, alertId) {
  const { index } = await readIndex(env);
  if (!index.alerts.includes(alertId)) {
    index.alerts.push(alertId);
    await writeIndex(env, index);
  }
}
__name(addAlertToIndex, "addAlertToIndex");
async function removeSubsFromIndex(env, subIds) {
  if (subIds.length === 0) return;
  const { index } = await readIndex(env);
  let changed = false;
  for (const id of subIds) {
    const i2 = index.subs.indexOf(id);
    if (i2 !== -1) {
      index.subs.splice(i2, 1);
      changed = true;
    }
  }
  if (changed) await writeIndex(env, index);
}
__name(removeSubsFromIndex, "removeSubsFromIndex");
async function handleSubscribe(request, env) {
  try {
    const body = await request.json();
    if (!body || !body.endpoint || !body.keys || !body.keys.p256dh || !body.keys.auth) {
      return json({ error: "Invalid subscription" }, 400);
    }
    const id = generateId();
    const subscription = {
      id,
      endpoint: body.endpoint,
      keys: { p256dh: body.keys.p256dh, auth: body.keys.auth },
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    await env.ALERTAS_KV.put(subKey(id), JSON.stringify(subscription));
    await addSubToIndex(env, id);
    return json({ id, ok: true });
  } catch (err) {
    console.error("[Subscribe] Erro:", err?.name, err?.message);
    return json({ error: "Subscribe failed", name: err?.name, message: err?.message }, 500);
  }
}
__name(handleSubscribe, "handleSubscribe");
async function handleUnsubscribe(request, env) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) return json({ error: "Missing id" }, 400);
  await env.ALERTAS_KV.delete(subKey(id));
  await removeSubFromIndex(env, id);
  return json({ ok: true });
}
__name(handleUnsubscribe, "handleUnsubscribe");
async function handleAlertsSync(request, env) {
  const body = await request.json();
  if (!body || !body.symbol) {
    return json({ error: "Invalid alert config" }, 400);
  }
  const id = body.symbol;
  const support = Number(body.support);
  const resistance = Number(body.resistance);
  const direction = body.direction || "BOTH";
  if (!Number.isFinite(support) || !Number.isFinite(resistance)) {
    return json({ error: "Invalid support/resistance" }, 400);
  }
  if (support >= resistance) {
    return json({ error: "Support must be below resistance" }, 400);
  }
  const levelsKey = buildLevelsKey(support, resistance, direction);
  const alert = {
    id,
    symbol: body.symbol,
    support,
    resistance,
    enabled: body.enabled !== false,
    direction,
    levelsKey,
    updatedAt: (/* @__PURE__ */ new Date()).toISOString()
  };
  await env.ALERTAS_KV.put(alertKey(id), JSON.stringify(alert));
  await addAlertToIndex(env, id);
  const statesRaw = await env.ALERTAS_KV.get(STATES_KEY);
  const allStates = statesRaw ? JSON.parse(statesRaw) : {};
  const state = allStates[id] || null;
  if (!state) {
    const seedPrice = Number.isFinite(body.lastPrice) ? body.lastPrice : null;
    allStates[id] = freshState(levelsKey, seedPrice);
    await env.ALERTAS_KV.put(STATES_KEY, JSON.stringify(allStates));
    return json({ ok: true, id });
  }
  const levelsChanged = !state.levelsKey || state.levelsKey !== levelsKey;
  if (levelsChanged) {
    allStates[id] = freshState(levelsKey, null);
    await env.ALERTAS_KV.put(STATES_KEY, JSON.stringify(allStates));
  }
  return json({ ok: true, id });
}
__name(handleAlertsSync, "handleAlertsSync");
async function sendWebPush(subscription, payload, env) {
  const pushPayload = await buildPushPayload(
    { data: payload },
    {
      endpoint: subscription.endpoint,
      keys: subscription.keys
    },
    {
      subject: env.VAPID_SUBJECT || "mailto:bitcoiniciantes@proton.me",
      publicKey: env.VAPID_PUBLIC_KEY,
      privateKey: env.VAPID_PRIVATE_KEY
    }
  );
  const res = await fetch(subscription.endpoint, pushPayload);
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    const err = new Error(`Push failed: HTTP ${res.status} ${bodyText}`.trim());
    err.status = res.status;
    throw err;
  }
  return { status: res.status, ok: true };
}
__name(sendWebPush, "sendWebPush");
async function broadcastPush(subscriptions, payload, env) {
  let delivered = 0;
  const deadSubIds = [];
  for (const sub of subscriptions) {
    try {
      await sendWebPush(sub, payload, env);
      delivered++;
    } catch (e) {
      console.error("[Push] Falha para sub " + sub.id + ": " + e.message);
      const deadStatuses = [400, 404, 410];
      if (deadStatuses.includes(e.status)) {
        deadSubIds.push(sub.id);
        console.error("[Push] Subscription " + sub.id + " marcada para remo\xE7\xE3o (status " + e.status + ")");
      }
    }
  }
  return { delivered, deadSubIds };
}
__name(broadcastPush, "broadcastPush");
var SYMBOL_TO_MEXC = {
  "BTC": "BTCUSDT",
  "ETH": "ETHUSDT",
  "SOL": "SOLUSDT",
  "LINK": "LINKUSDT",
  "AVAX": "AVAXUSDT",
  "RENDER": "RENDERUSDT",
  "PAXG": "GOLD(PAXG)USDT",
  "USDT-BRL": "USDCBRL"
};
async function fetchPrices(symbols) {
  const prices = /* @__PURE__ */ new Map();
  const fetchPromises = [];
  for (const sym of symbols) {
    const mexcSymbol = SYMBOL_TO_MEXC[sym];
    if (mexcSymbol) {
      const p = fetch("https://api.mexc.com/api/v3/ticker/price?symbol=" + mexcSymbol).then((res) => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      }).then((data) => {
        const price = Number(data.price);
        if (Number.isFinite(price)) {
          prices.set(sym, price);
          console.log("[Prices] MEXC " + sym + ": $" + price);
        }
      }).catch((e) => console.error("[Prices] MEXC " + sym + ": " + e.message));
      fetchPromises.push(p);
    }
  }
  await Promise.all(fetchPromises);
  return prices;
}
__name(fetchPrices, "fetchPrices");
async function fetchPriceSequences(symbols, samples = 3, intervalMs = 15e3) {
  const seqMap = /* @__PURE__ */ new Map();
  for (let i2 = 0; i2 < samples; i2++) {
    const prices = await fetchPrices(symbols);
    for (const [sym, price] of prices) {
      if (!seqMap.has(sym)) seqMap.set(sym, []);
      seqMap.get(sym).push(price);
    }
    if (i2 < samples - 1) await sleep(intervalMs);
  }
  return seqMap;
}
__name(fetchPriceSequences, "fetchPriceSequences");
function crossedResistance(previousPrice, currentPrice, resistance) {
  return previousPrice < resistance && currentPrice >= resistance;
}
__name(crossedResistance, "crossedResistance");
function crossedSupport(previousPrice, currentPrice, support) {
  return previousPrice > support && currentPrice <= support;
}
__name(crossedSupport, "crossedSupport");
function buildAlertPayload(symbol, directionType, level, priceAtEvent) {
  const symbolName = symbol.replace("USDT", "").replace("BRL", "");
  const dirLabel = directionType === "RESISTANCE" ? "Resist\xEAncia" : "Suporte";
  const isBRL = symbol.includes("BRL");
  const fmt = new Intl.NumberFormat("pt-BR", { style: "currency", currency: isBRL ? "BRL" : "USD" });
  return {
    title: symbolName + " \u2014 " + dirLabel + " rompida",
    body: symbolName + " cruzou " + dirLabel + " em " + fmt.format(level) + " (pre\xE7o no momento: " + fmt.format(priceAtEvent) + ")",
    url: "/",
    symbol,
    level,
    direction: directionType
  };
}
__name(buildAlertPayload, "buildAlertPayload");
async function scheduledHandler(event, env) {
  const { index, isNew } = await readIndex(env);
  if (isNew) {
    console.log("[Cron] \xCDndice inexistente \u2014 criando a partir de LIST...");
    const alertList = await env.ALERTAS_KV.list({ prefix: "alert:" });
    const subList = await env.ALERTAS_KV.list({ prefix: "sub:" });
    index.alerts = alertList.keys.map((k) => k.name.replace("alert:", ""));
    index.subs = subList.keys.map((k) => k.name.replace("sub:", ""));
    await writeIndex(env, index);
    console.log("[Cron] \xCDndice criado: " + index.alerts.length + " alertas, " + index.subs.length + " subs");
  }
  if (index.alerts.length === 0) return;
  const symbolAlerts = /* @__PURE__ */ new Map();
  for (const alertId of index.alerts) {
    const val = await env.ALERTAS_KV.get(alertKey(alertId));
    if (!val) continue;
    const alert = JSON.parse(val);
    if (!alert.enabled) continue;
    if (!symbolAlerts.has(alert.symbol)) symbolAlerts.set(alert.symbol, []);
    symbolAlerts.get(alert.symbol).push(alert);
  }
  const subscriptions = [];
  for (const subId of index.subs) {
    const val = await env.ALERTAS_KV.get(subKey(subId));
    if (val) subscriptions.push(JSON.parse(val));
  }
  if (subscriptions.length === 0) return;
  const statesRaw = await env.ALERTAS_KV.get(STATES_KEY);
  let allStates = statesRaw ? JSON.parse(statesRaw) : {};
  if (statesRaw === null) {
    const legacyKeys = await env.ALERTAS_KV.list({ prefix: "state:" });
    for (const key of legacyKeys.keys) {
      const raw = await env.ALERTAS_KV.get(key.name);
      if (raw) {
        const id = key.name.replace("state:", "");
        if (!allStates[id]) allStates[id] = JSON.parse(raw);
      }
      await env.ALERTAS_KV.delete(key.name);
    }
    if (legacyKeys.keys.length > 0) {
      console.log("[Cron] Migra\xE7\xE3o: " + legacyKeys.keys.length + " chaves state:* consolidadas em cron:states");
    }
    await env.ALERTAS_KV.put(STATES_KEY, JSON.stringify(allStates));
  }
  const eventSnapshot = {};
  for (const [id, state] of Object.entries(allStates)) {
    eventSnapshot[id] = {
      rt: state.resistanceTriggered,
      st: state.supportTriggered,
      pr: state.pendingResistance,
      ps: state.pendingSupport,
      lk: state.levelsKey,
      lp: state.lastPrice,
      lrt: state.lastResistanceTriggeredAt,
      lst: state.lastSupportTriggeredAt
    };
  }
  const allSymbols = [...symbolAlerts.keys()];
  const sequences = await fetchPriceSequences(allSymbols);
  const allDeadSubIds = [];
  for (const [symbol, alerts] of symbolAlerts) {
    const seq = sequences.get(symbol);
    if (!seq || seq.length === 0) {
      console.error("[Cron] Sem pre\xE7o para " + symbol + " neste ciclo \u2014 pulando avalia\xE7\xE3o.");
      continue;
    }
    const currentPrice = seq[seq.length - 1];
    const isBtcTrace = symbol === "BTC";
    for (const alert of alerts) {
      const levelsKey = buildLevelsKey(alert.support, alert.resistance, alert.direction);
      let state = allStates[alert.id] || freshState(levelsKey, null);
      if (!state.levelsKey || state.levelsKey !== levelsKey) {
        state = freshState(levelsKey, currentPrice);
        allStates[alert.id] = state;
        continue;
      }
      if (state.lastPrice === null) {
        state.lastPrice = currentPrice;
        allStates[alert.id] = state;
        continue;
      }
      const wantsResistance = alert.direction === "BOTH" || alert.direction === "RESISTANCE";
      const wantsSupport = alert.direction === "BOTH" || alert.direction === "SUPPORT";
      if (isBtcTrace) console.log("[WORKER TRACE] symbol=" + symbol + " support=" + alert.support + " resistance=" + alert.resistance + " previousPrice=" + state.lastPrice + " seq=" + JSON.stringify(seq) + " currentPrice=" + currentPrice + " resistanceTriggered=" + state.resistanceTriggered + " supportTriggered=" + state.supportTriggered + " lastResistanceTriggeredAt=" + state.lastResistanceTriggeredAt + " lastSupportTriggeredAt=" + state.lastSupportTriggeredAt);
      if (state.pendingResistance) {
        const payload = buildAlertPayload(symbol, "RESISTANCE", alert.resistance, state.pendingResistance.price);
        const { delivered, deadSubIds } = await broadcastPush(subscriptions, payload, env);
        if (isBtcTrace) console.log("[WORKER TRACE] PUSH symbol=" + symbol + " kind=retry direction=RESISTANCE delivered=" + delivered + " deadSubIds=" + JSON.stringify(deadSubIds));
        allDeadSubIds.push(...deadSubIds);
        if (delivered > 0) {
          state.resistanceTriggered = true;
          state.pendingResistance = null;
          state.lastResistanceTriggeredAt = (/* @__PURE__ */ new Date()).toISOString();
          console.log("[Cron] RESISTANCE retry confirmado \u2014 " + symbol + " \u2014 push entregue \u2014 cooldown iniciado");
        } else {
          console.error("[Cron] Retry de RESIST\xCANCIA pendente (" + symbol + ") ainda falhou \u2014 tenta de novo no pr\xF3ximo ciclo.");
        }
      }
      if (state.pendingSupport) {
        const payload = buildAlertPayload(symbol, "SUPPORT", alert.support, state.pendingSupport.price);
        const { delivered, deadSubIds } = await broadcastPush(subscriptions, payload, env);
        if (isBtcTrace) console.log("[WORKER TRACE] PUSH symbol=" + symbol + " kind=retry direction=SUPPORT delivered=" + delivered + " deadSubIds=" + JSON.stringify(deadSubIds));
        allDeadSubIds.push(...deadSubIds);
        if (delivered > 0) {
          state.supportTriggered = true;
          state.pendingSupport = null;
          state.lastSupportTriggeredAt = (/* @__PURE__ */ new Date()).toISOString();
          console.log("[Cron] SUPPORT retry confirmado \u2014 " + symbol + " \u2014 push entregue \u2014 cooldown iniciado");
        } else {
          console.error("[Cron] Retry de SUPORTE pendente (" + symbol + ") ainda falhou \u2014 tenta de novo no pr\xF3ximo ciclo.");
        }
      }
      if (state.resistanceTriggered && currentPrice < alert.resistance * (1 - HYSTERESIS_PCT)) {
        state.resistanceTriggered = false;
        console.log("[Cron] RESISTANCE rearmada por hysteresis \u2014 " + symbol + " \u2014 pre\xE7o: " + currentPrice + " \u2014 threshold: " + alert.resistance * (1 - HYSTERESIS_PCT));
      }
      if (state.supportTriggered && currentPrice > alert.support * (1 + HYSTERESIS_PCT)) {
        state.supportTriggered = false;
        console.log("[Cron] SUPPORT rearmada por hysteresis \u2014 " + symbol + " \u2014 pre\xE7o: " + currentPrice + " \u2014 threshold: " + alert.support * (1 + HYSTERESIS_PCT));
      }
      if (isBtcTrace) console.log("[WORKER TRACE] REARM symbol=" + symbol + " currentPrice=" + currentPrice + " resistance=" + alert.resistance + " resThreshold=" + alert.resistance * (1 - HYSTERESIS_PCT) + " support=" + alert.support + " supThreshold=" + alert.support * (1 + HYSTERESIS_PCT) + " resistanceTriggered=" + state.resistanceTriggered + " supportTriggered=" + state.supportTriggered);
      let resistanceCrossPrice = null;
      let supportCrossPrice = null;
      let prev = state.lastPrice;
      const now = Date.now();
      const lastResistanceTs = safeTimestamp(state.lastResistanceTriggeredAt);
      const lastSupportTs = safeTimestamp(state.lastSupportTriggeredAt);
      const cooldownResistanceOk = lastResistanceTs === null || now - lastResistanceTs >= COOLDOWN_MS;
      const cooldownSupportOk = lastSupportTs === null || now - lastSupportTs >= COOLDOWN_MS;
      if (isBtcTrace) console.log("[WORKER TRACE] COOLDOWN symbol=" + symbol + " now=" + now + " lastResistanceTs=" + lastResistanceTs + " elapsedResMs=" + (lastResistanceTs === null ? null : now - lastResistanceTs) + " lastSupportTs=" + lastSupportTs + " elapsedSupMs=" + (lastSupportTs === null ? null : now - lastSupportTs) + " cooldownMs=" + COOLDOWN_MS + " cooldownResistanceOk=" + cooldownResistanceOk + " cooldownSupportOk=" + cooldownSupportOk);
      if (wantsResistance && !cooldownResistanceOk && !state.resistanceTriggered && !state.pendingResistance) {
        const remainingResistanceMs = COOLDOWN_MS - (now - lastResistanceTs);
        console.log("[Cron] RESISTANCE cooldown ativo \u2014 " + symbol + " \u2014 restante: " + Math.ceil(remainingResistanceMs / 1e3) + "s");
      }
      if (wantsSupport && !cooldownSupportOk && !state.supportTriggered && !state.pendingSupport) {
        const remainingSupportMs = COOLDOWN_MS - (now - lastSupportTs);
        console.log("[Cron] SUPPORT cooldown ativo \u2014 " + symbol + " \u2014 restante: " + Math.ceil(remainingSupportMs / 1e3) + "s");
      }
      for (const price of seq) {
        if (wantsResistance && !state.resistanceTriggered && !state.pendingResistance && resistanceCrossPrice === null && cooldownResistanceOk) {
          if (crossedResistance(prev, price, alert.resistance)) resistanceCrossPrice = price;
        }
        if (wantsSupport && !state.supportTriggered && !state.pendingSupport && supportCrossPrice === null && cooldownSupportOk) {
          if (crossedSupport(prev, price, alert.support)) supportCrossPrice = price;
        }
        prev = price;
      }
      if (isBtcTrace) console.log("[WORKER TRACE] CROSS symbol=" + symbol + " previousPrice=" + state.lastPrice + " seq=" + JSON.stringify(seq) + " currentPrice=" + currentPrice + " resistance=" + alert.resistance + " support=" + alert.support + " resistanceCrossPrice=" + resistanceCrossPrice + " supportCrossPrice=" + supportCrossPrice);
      if (resistanceCrossPrice !== null) {
        console.log("[Cron] RESISTANCE crossover detectado \u2014 " + symbol + " \u2014 pre\xE7o: " + resistanceCrossPrice + " \u2014 n\xEDvel: " + alert.resistance);
        if (isBtcTrace) console.log("[WORKER TRACE] TRIGGER symbol=" + symbol + " direction=RESISTANCE price=" + resistanceCrossPrice + " level=" + alert.resistance);
        const payload = buildAlertPayload(symbol, "RESISTANCE", alert.resistance, resistanceCrossPrice);
        const { delivered, deadSubIds } = await broadcastPush(subscriptions, payload, env);
        if (isBtcTrace) console.log("[WORKER TRACE] PUSH symbol=" + symbol + " kind=fresh direction=RESISTANCE delivered=" + delivered + " deadSubIds=" + JSON.stringify(deadSubIds));
        allDeadSubIds.push(...deadSubIds);
        if (delivered > 0) {
          state.resistanceTriggered = true;
          state.lastResistanceTriggeredAt = (/* @__PURE__ */ new Date()).toISOString();
          console.log("[Cron] RESISTANCE push confirmado \u2014 " + symbol + " \u2014 pr\xF3ximo disparo em 5min");
        } else {
          state.pendingResistance = { level: alert.resistance, price: resistanceCrossPrice, detectedAt: (/* @__PURE__ */ new Date()).toISOString() };
          console.error("[Cron] Crossover de RESIST\xCANCIA em " + symbol + " detectado mas 0 pushes entregues \u2014 marcado pendente, retry no pr\xF3ximo ciclo.");
        }
      }
      if (supportCrossPrice !== null) {
        console.log("[Cron] SUPPORT crossover detectado \u2014 " + symbol + " \u2014 pre\xE7o: " + supportCrossPrice + " \u2014 n\xEDvel: " + alert.support);
        if (isBtcTrace) console.log("[WORKER TRACE] TRIGGER symbol=" + symbol + " direction=SUPPORT price=" + supportCrossPrice + " level=" + alert.support);
        const payload = buildAlertPayload(symbol, "SUPPORT", alert.support, supportCrossPrice);
        const { delivered, deadSubIds } = await broadcastPush(subscriptions, payload, env);
        if (isBtcTrace) console.log("[WORKER TRACE] PUSH symbol=" + symbol + " kind=fresh direction=SUPPORT delivered=" + delivered + " deadSubIds=" + JSON.stringify(deadSubIds));
        allDeadSubIds.push(...deadSubIds);
        if (delivered > 0) {
          state.supportTriggered = true;
          state.lastSupportTriggeredAt = (/* @__PURE__ */ new Date()).toISOString();
          console.log("[Cron] SUPPORT push confirmado \u2014 " + symbol + " \u2014 pr\xF3ximo disparo em 5min");
        } else {
          state.pendingSupport = { level: alert.support, price: supportCrossPrice, detectedAt: (/* @__PURE__ */ new Date()).toISOString() };
          console.error("[Cron] Crossover de SUPORTE em " + symbol + " detectado mas 0 pushes entregues \u2014 marcado pendente, retry no pr\xF3ximo ciclo.");
        }
      }
      state.lastPrice = currentPrice;
      allStates[alert.id] = state;
    }
  }
  const uniqueDeadSubIds = [...new Set(allDeadSubIds)];
  for (const deadId of uniqueDeadSubIds) {
    await env.ALERTAS_KV.delete(subKey(deadId));
  }
  await removeSubsFromIndex(env, uniqueDeadSubIds);
  let stateChanged = uniqueDeadSubIds.length > 0;
  if (!stateChanged) {
    for (const [id, state] of Object.entries(allStates)) {
      const prev = eventSnapshot[id];
      if (!prev) {
        stateChanged = true;
        break;
      }
      if (state.resistanceTriggered !== prev.rt) {
        stateChanged = true;
        break;
      }
      if (state.supportTriggered !== prev.st) {
        stateChanged = true;
        break;
      }
      if (JSON.stringify(state.pendingResistance) !== JSON.stringify(prev.pr)) {
        stateChanged = true;
        break;
      }
      if (JSON.stringify(state.pendingSupport) !== JSON.stringify(prev.ps)) {
        stateChanged = true;
        break;
      }
      if (state.levelsKey !== prev.lk) {
        stateChanged = true;
        break;
      }
      if (prev.lp === null && state.lastPrice !== null) {
        stateChanged = true;
        break;
      }
      if (state.lastResistanceTriggeredAt !== prev.lrt) {
        stateChanged = true;
        break;
      }
      if (state.lastSupportTriggeredAt !== prev.lst) {
        stateChanged = true;
        break;
      }
    }
    if (!stateChanged) {
      for (const id of Object.keys(eventSnapshot)) {
        if (!allStates[id]) {
          stateChanged = true;
          break;
        }
      }
    }
  }
  if (stateChanged) {
    await env.ALERTAS_KV.put(STATES_KEY, JSON.stringify(allStates));
    console.log("[Cron] Estado salvo em cron:states (" + Object.keys(allStates).length + " alertas)");
  } else {
    console.log("[Cron] Nenhuma mudan\xE7a \u2014 put omitido");
  }
}
__name(scheduledHandler, "scheduledHandler");
var index_default = {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return handleOptions();
    const url = new URL(request.url);
    const path = url.pathname;
    try {
      if (path === "/subscribe" && request.method === "POST") {
        return handleSubscribe(request, env);
      }
      if (path === "/unsubscribe" && request.method === "POST") {
        return handleUnsubscribe(request, env);
      }
      if (path === "/alerts/sync" && request.method === "POST") {
        return handleAlertsSync(request, env);
      }
      if (path === "/" && request.method === "GET") {
        return json({ service: "alerta-worker", status: "ok", version: "7.0.0" });
      }
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },
  async scheduled(event, env, ctx) {
    try {
      await scheduledHandler(event, env);
    } catch (err) {
      console.error("[Scheduled] Error:", err.message);
    }
  }
};
export {
  index_default as default
};
//# sourceMappingURL=index.js.map
