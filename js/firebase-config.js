// Plak hier de waarden uit Firebase (Projectinstellingen > Je apps > Config). Zolang dit leeg is, werkt de app gewoon zonder account.
// Deze waarden zijn geen geheimen: de beveiliging zit in de Firestore-regels (cloud/firestore.rules).
export const firebaseConfig = {
  apiKey: 'AIzaSyAmLgULrc0wlVP-J8abtWnGL_hNaVlfXik',
  authDomain: 'knooppunten-eb98e.firebaseapp.com',
  projectId: 'knooppunten-eb98e',
  storageBucket: 'knooppunten-eb98e.firebasestorage.app',
  messagingSenderId: '176863705280',
  appId: '1:176863705280:web:0c43bb5694a779b9a9d525',
};
export const configured = () => !!firebaseConfig.apiKey && !/PLAK/i.test(firebaseConfig.apiKey);
