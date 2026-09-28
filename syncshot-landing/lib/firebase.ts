import { getApp, getApps, initializeApp } from "firebase/app"
import { getAuth } from "firebase/auth"
const app = getApps().length ? getApp() : initializeApp({
  apiKey: "AIzaSyApIWE3umXq6BDvxiB7fCm6NHgsZZfB4nE",
  authDomain: "syncshot-v2.firebaseapp.com",
  projectId: "syncshot-v2",
  storageBucket: "syncshot-v2.firebasestorage.app",
  messagingSenderId: "424325660516",
  appId: "1:424325660516:web:f839ae266e68a32ffec471",
})
export const auth = getAuth(app)
