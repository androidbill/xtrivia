// xTrivia's own Firebase project config.
//
// This app uses only the Realtime Database product (no Firestore, no Auth). To stand up
// your own backend:
//   1. https://console.firebase.google.com -> Add project (any name, e.g. "xtrivia").
//   2. Build -> Realtime Database -> Create Database -> start in "locked mode" (the rules
//      in ../database.rules.json get deployed over that default separately).
//   3. Project settings -> General -> "Your apps" -> Add app -> Web (</>) -> register it,
//      no Firebase Hosting needed. Copy the `firebaseConfig` object it shows you and
//      paste its values in below.
//   4. Deploy the rules once you have the Firebase CLI: from the repo root run
//      `firebase deploy --only database --project <your-project-id>`.
//
// This file is safe to commit — a Firebase web config is a public client identifier, not
// a secret; access is controlled by database.rules.json, not by hiding this object.
export const firebaseConfig = {
  apiKey: 'AIzaSyALnv2pcuOqoh55LZrFOpKu11kULkZmgq0',
  authDomain: 'xtrivia-92142.firebaseapp.com',
  databaseURL: 'https://xtrivia-92142-default-rtdb.firebaseio.com',
  projectId: 'xtrivia-92142',
  storageBucket: 'xtrivia-92142.firebasestorage.app',
  messagingSenderId: '950978595815',
  appId: '1:950978595815:web:63593325ce825add2f8b42',
  measurementId: 'G-DJDMJW2MQD',
};
