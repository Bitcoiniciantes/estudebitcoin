/* Fake Firestore em memória para testar os handlers (sem emulador/Java).
 * Suporta o subconjunto usado em index.js: collection/doc refs aninhados,
 * tx.get(doc), tx.get(query collection), tx.getAll(...), tx.set (merge),
 * tx.update, tx.delete, runTransaction (execução única).
 */
'use strict';

function deepClone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

class FakeStore {
  constructor() {
    this.docs = new Map(); // path -> data
  }

  collection(name) {
    return new FakeCollectionRef(this, name);
  }
}

let autoId = 0;

class FakeCollectionRef {
  constructor(store, path) {
    this._store = store;
    this._path = path;
  }

  doc(id) {
    if (!id) id = 'auto' + (++autoId);
    return new FakeDocRef(this._store, this._path + '/' + id);
  }
}

class FakeDocRef {
  constructor(store, path) {
    this._store = store;
    this._path = path;
  }

  get id() {
    return this._path.split('/').pop();
  }

  collection(name) {
    return new FakeCollectionRef(this._store, this._path + '/' + name);
  }

  // Leitura direta fora de transação (atualizarAtivo usa este caminho).
  async get() {
    const data = this._store.docs.get(this._path);
    return {
      exists: data !== undefined,
      data: () => deepClone(data),
      ref: this,
      id: this.id,
    };
  }

  async update(data) {
    if (!this._store.docs.has(this._path)) throw new Error('fake: update em doc inexistente');
    const cur = this._store.docs.get(this._path);
    const next = { ...deepClone(cur) };
    for (const k of Object.keys(data)) {
      if (data[k] && data[k].__del) delete next[k];
      else next[k] = deepClone(data[k]);
    }
    this._store.docs.set(this._path, next);
  }
}

class FakeTx {
  constructor(store) {
    this._store = store;
    this._writes = [];
  }

  _snap(ref) {
    const data = this._store.docs.get(ref._path);
    return {
      exists: data !== undefined,
      data: () => deepClone(data),
      ref,
      id: ref.id,
    };
  }

  async get(refOrQuery) {
    if (refOrQuery instanceof FakeDocRef) return this._snap(refOrQuery);
    if (refOrQuery instanceof FakeCollectionRef) {
      const prefix = refOrQuery._path + '/';
      const docs = [];
      for (const [path, data] of this._store.docs) {
        if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) {
          docs.push({
            id: path.slice(prefix.length),
            exists: true,
            data: () => deepClone(data),
            ref: new FakeDocRef(this._store, path),
          });
        }
      }
      return { docs, size: docs.length, empty: docs.length === 0 };
    }
    throw new Error('fake: get() só aceita doc ou collection');
  }

  async getAll(...refs) {
    const out = [];
    for (const r of refs) out.push(await this.get(r));
    return out;
  }

  set(ref, data, opts) {
    this._writes.push(() => {
      if (opts && opts.merge) {
        const cur = this._store.docs.get(ref._path) || {};
        this._store.docs.set(ref._path, { ...deepClone(cur), ...deepClone(data) });
      } else {
        this._store.docs.set(ref._path, deepClone(data));
      }
    });
  }

  update(ref, data) {
    this._writes.push(() => {
      if (!this._store.docs.has(ref._path)) throw new Error('fake: update em doc inexistente');
      const cur = this._store.docs.get(ref._path);
      const next = { ...deepClone(cur) };
      for (const k of Object.keys(data)) {
        if (data[k] && data[k].__del) delete next[k];
        else next[k] = deepClone(data[k]);
      }
      this._store.docs.set(ref._path, next);
    });
  }

  delete(ref) {
    this._writes.push(() => { this._store.docs.delete(ref._path); });
  }

  _commit() {
    for (const w of this._writes) w();
    this._writes = [];
  }
}

function makeFakeAdmin() {
  const store = new FakeStore();
  const FieldValue = {
    serverTimestamp: () => 'TS',
    delete: () => ({ __del: true }),
  };
  const firestoreFn = () => ({
    collection: (n) => store.collection(n),
    runTransaction: async (fn) => {
      const tx = new FakeTx(store);
      const out = await fn(tx);
      tx._commit();
      return out;
    },
  });
  firestoreFn.FieldValue = FieldValue;
  return {
    store,
    admin: {
      initializeApp: () => {},
      firestore: firestoreFn,
    },
  };
}

class HttpsError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

module.exports = { makeFakeAdmin, HttpsError, FakeStore };
