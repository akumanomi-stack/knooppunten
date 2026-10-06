// Koppeling met Firebase (Auth + Firestore), geladen van Google. Alleen als firebase-config.js is ingevuld.
const V = '10.14.1';
const BASE = `https://www.gstatic.com/firebasejs/${V}/`;

export async function createFirebaseAdapter(config) {
  const [{ initializeApp }, A, F] = await Promise.all([
    import(`${BASE}firebase-app.js`),
    import(`${BASE}firebase-auth.js`),
    import(`${BASE}firebase-firestore.js`),
  ]);
  const app = initializeApp(config);
  const auth = A.getAuth(app);
  const db = F.getFirestore(app);
  const { doc, collection, getDoc, getDocs, setDoc, deleteDoc, addDoc, query, where, orderBy, limit, writeBatch, increment } = F;

  const withId = (d) => ({ id: d.id, ...d.data() });

  return {
    onAuth(cb) {
      A.onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, photo: u.photoURL || '' } : null));
    },
    async signIn() {
      const provider = new A.GoogleAuthProvider();
      try {
        await A.signInWithPopup(auth, provider);
      } catch (e) {
        if (e && (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment')) {
          await A.signInWithRedirect(auth, provider);
        } else if (!e || (e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request')) {
          throw e;
        }
      }
    },
    signOut: () => A.signOut(auth),

    async getProfile(uid) {
      const d = await getDoc(doc(db, 'users', uid));
      return d.exists() ? d.data() : null;
    },
    setProfile: (uid, data) => setDoc(doc(db, 'users', uid), data, { merge: true }),

    // Het id van de route is zijn vingerafdruk: dezelfde route kan dus maar één keer bestaan.
    async exists(sig) {
      return (await getDoc(doc(db, 'routes', sig))).exists();
    },
    async publish(route) {
      await setDoc(doc(db, 'routes', route.sig), route);
      return route.sig;
    },
    async listPublic(sort) {
      const q = query(collection(db, 'routes'), orderBy(sort === 'new' ? 'createdAt' : 'votes', 'desc'), limit(200));
      return (await getDocs(q)).docs.map(withId);
    },
    async listMine(uid) {
      const q = query(collection(db, 'routes'), where('ownerUid', '==', uid), limit(60));
      return (await getDocs(q)).docs.map(withId);
    },
    deleteRoute: (id) => deleteDoc(doc(db, 'routes', id)),

    async listFavs(uid) {
      return (await getDocs(collection(db, 'users', uid, 'favs'))).docs.map(withId);
    },
    async setFav(uid, route, on) {
      const ref = doc(db, 'users', uid, 'favs', route.id);
      if (!on) return deleteDoc(ref);
      const { id, starred, voted, mine, ...copy } = route;
      return setDoc(ref, copy);
    },

    async listVoted(uid) {
      return (await getDocs(collection(db, 'users', uid, 'voted'))).docs.map((d) => d.id);
    },
    async setVote(uid, routeId, on) {
      const b = writeBatch(db);
      const routeRef = doc(db, 'routes', routeId);
      const voteRef = doc(db, 'routes', routeId, 'votes', uid);
      const mirror = doc(db, 'users', uid, 'voted', routeId);
      if (on) {
        b.set(voteRef, { at: Date.now() });
        b.set(mirror, { at: Date.now() });
        b.update(routeRef, { votes: increment(1) });
      } else {
        b.delete(voteRef);
        b.delete(mirror);
        b.update(routeRef, { votes: increment(-1) });
      }
      return b.commit();
    },

    report: (uid, routeId) => setDoc(doc(db, 'routes', routeId, 'reports', uid), { at: Date.now() }),
  };
}
