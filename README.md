# Stockly: public inventory with administrator editing

Visitors can view the shared inventory without signing in. Only the Firebase administrator account can add/delete items or change quantities.

## Firebase setup

1. Create/register the Firebase web app and paste its configuration into `firebase-config.js`.
2. Enable **Authentication > Sign-in method > Email/Password**.
3. Under **Authentication > Users**, click **Add user**. Use an email address you control and initially set the requested password `12345678`. Changing it to a stronger unique password is strongly recommended.
4. Copy that user's **User UID**.
5. In `admin-config.js`, replace `admin@example.com` with the same Firebase account email. The visible website username remains `korbit`.
6. In `firestore.rules`, replace `PASTE_ADMIN_UID_HERE` with the copied UID in all three places.
7. Create Firestore Standard edition, then paste `firestore.rules` into **Firestore Database > Rules** and publish.
8. In **Authentication > Settings > Authorized domains**, add `YOUR-GITHUB-USERNAME.github.io`.
9. Upload all project files to the root of a GitHub repository. Under **Settings > Pages**, deploy `main` from `/(root)`.

## Security design

- The password is not present in HTML or JavaScript. Firebase Authentication checks it.
- The username `korbit` is only a friendly login label. Firebase signs in using the email configured in `admin-config.js`.
- Firestore rules enforce the copied admin UID. Hiding buttons alone is not security.
- `allow read: if true` intentionally makes quantities public to anyone who can access the site.
- Never upload a Firebase service-account key.

## Important

The administrator password `12345678` is weak and becomes especially risky if it is shared or reused. Use it only as an initial password, then replace it in Firebase Authentication with a long unique password.
