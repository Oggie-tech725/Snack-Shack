# Snack-Shack — Inventory, Reservations & Wishlist

A public snack inventory for the Snack-Shack, built with plain HTML/CSS/JS and Firebase.
Visitors can see what is in stock, reserve one item for a pickup window, and suggest missing
products. Only the administrator can edit the inventory, manage reservations, or read the
wishlist.

## What is new

- **Opening-hours badge** in the info panel: “Jetzt geöffnet · bis 13:00” or
  “Geschlossen · öffnet morgen um 10:15”. It uses `Europe/Zurich`, so it is correct even
  when a visitor opens the page from another time zone.
- **Reservations for customers**: pick a product, a date and one of the daily opening
  windows. The stock is reduced by exactly 1 in the same Firestore transaction, and a
  reservation document is created. The admin sees all pending pickups and can mark them
  as picked up (profit is booked automatically) or cancel them (stock is restored).
- **SMS notification**: the prepared message contains the product, the pickup window and
  a short reservation code. Automatic sending uses the included Cloud Function; without
  a function, the confirmation shows a one-tap `sms:` link with the text pre-filled.
- **Wishlist (“Was fehlt?”)**: visitors can suggest a product with an optional note.
  Only the admin can read or manage the wishes.
- **Twint dialog**: shows the Twint number and an optional payment link. See the Twint
  section below for why a normal Twint account cannot create a QR code.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Page structure and all dialogs |
| `app.js` | Firebase logic, opening hours, reservations, wishlist |
| `style.css` | Design and responsive layout |
| `shop-config.js` | Opening hours, phone numbers, SMS endpoint, optional Twint link |
| `firestore.rules` | Firestore security rules (must be published) |
| `functions/` | Optional Cloud Function that sends the SMS |
| `firebase.json`, `.firebaserc` | Firebase CLI configuration |

## Firebase setup

1. Create/register the Firebase web app and paste its configuration into
   `firebase-config.js`.
2. Enable **Authentication > Sign-in method > Email/Password**.
3. Under **Authentication > Users**, add the admin user. Replace the initial password
   `12345678` with a long unique password as soon as possible.
4. Copy that user's **User UID**.
5. In `admin-config.js`, set `ADMIN_EMAIL` to the same Firebase account email. The visible
   username remains `korbit`.
6. In `firestore.rules`, replace the admin UID if it ever changes. The current UID is
   already filled in.
7. **Publish the rules:** Firebase Console > Firestore Database > Rules > paste
   `firestore.rules` > **Publish**. Alternatively, from the project folder run
   `firebase deploy --only firestore:rules`. Without this step the profit, reservations
   and wishlist show an error.
8. In **Authentication > Settings > Authorized domains**, add
   `YOUR-GITHUB-USERNAME.github.io`.
9. Upload all site files to the root of the GitHub repository and deploy via
   **Settings > Pages** (`main`, `/(root)`).

> GitHub Pages is case-sensitive. The script tag in `index.html` points to `app.js`
> (lowercase), so the file must be named `app.js` in the repository.

## Opening hours

Edit `shop-config.js`:

```js
openingHours: [
  { start: "10:15", end: "10:30" },
  { start: "12:05", end: "13:00" },
  { start: "14:45", end: "14:55" }
]
```

The shop is assumed to be open every day. The badge, the reservation date picker and the
pickup-window validation all use this list and the `Europe/Zurich` time zone.

> The reservation rules in `firestore.rules` also list the three opening windows so that a
> manipulated browser cannot book an arbitrary time. If you change `openingHours`, update
> the three `pickupStart`/`pickupEnd` pairs in `firestore.rules` and publish the rules again.

## How a reservation works

1. The visitor clicks **Artikel reservieren**.
2. They choose a product, a pickup date (up to 14 days ahead) and a remaining opening
   window.
3. On submit, the browser runs a Firestore transaction:
   - read the current quantity,
   - write `quantity - 1`, `updatedAt` and `lastReservationId`,
   - create a document in `reservations` with the product, pickup window, optional name
     and phone number, a short code, and `status: "pending"`.
4. The Firestore rules allow this public stock change **only** when it is exactly `-1`,
   changes no other product fields, and is paired with a matching new reservation
   document in the same transaction. Visitors cannot rename products, change prices, or
   increase stock. The reservation rule also checks the inventory write in the other
   direction, so a reservation cannot be created without the stock move.
5. The confirmation dialog shows the reservation code and either “SMS sent” or a
   prepared SMS link.
6. The admin sees the reservation under **Abholungen**:
   - **Abgeholt** marks it as picked up and adds the profit to `meta/stats`.
   - **Stornieren** cancels it and adds the unit back to the stock.

Reservations are stored with `status: "pending"`; the admin list only shows pending ones.
A reservation that is past its pickup window is highlighted as “überfällig”.

## Profit (`Totaler Gewinn`)

The total profit is stored in Firestore at `meta/stats` and is admin-only. It is increased
when the admin presses **−** on an item (`sell price − buy price`) and when a reservation
is marked **Abgeholt**. **Stornieren** restores the stock without booking profit. The
**Reset** button sets the total back to `0.00 CHF`.

### SMS without a server

If `SHOP_CONFIG.smsEndpoint` is empty, the success dialog shows:

- a **SMS senden** button (`sms:+41775131586?body=…`), which opens the phone's messaging
  app with the text already filled in, and
- a **Text kopieren** button.

The reservation and the stock change are already saved at that point. The customer only
has to press “send” in their SMS app.

### Automatic SMS with the included Cloud Function

Automatic sending needs a server-side component because an SMS API key must never be
placed in public JavaScript. The included function uses either **seven.io** or **Twilio**.

Prerequisites:

- Firebase project on the **Blaze** plan (Cloud Functions require it; there is a free
  monthly allowance, but SMS itself costs money).
- An account at [seven.io](https://www.seven.io/) or [Twilio](https://www.twilio.com/).
- Node.js 20 and the Firebase CLI (`npm install -g firebase-tools`).

Steps:

```bash
cd functions
npm install
cp .env.example .env      # Windows: copy .env.example .env
# edit .env and fill in ONE provider
cd ..
firebase login
firebase use snack-shack-5bb27
firebase deploy --only functions
```

The CLI prints the function URL. Paste it into `shop-config.js`:

```js
smsEndpoint: "https://notifyreservation-XXXXXXXX-ew.a.run.app"
```

Use exactly the URL printed by the CLI (v2 functions normally end in `.run.app`), then
deploy the site again.

The function:

- accepts only a `reservationId`,
- does not send again after a successful send (`smsStatus: sent`),
- refuses reservations older than one hour or no longer pending,
- writes `smsStatus: sent` or `smsStatus: failed` back to the reservation,
- returns `503 not_configured` when no provider is configured, so the frontend simply
  falls back to the SMS link.

`SHOP_SMS_TO` in `functions/.env` must stay `+41775131586` (or whatever number should
receive the notifications). Keep `SHOP_CONFIG.smsTo` in `shop-config.js` in sync.
Use a sender that your SMS provider has approved for Swiss recipients; alphanumeric
senders may need registration with the provider.

> Never commit the real `functions/.env`. It is ignored by `functions/.gitignore`.
> `firestore.rules` and the frontend contain no secrets.

## Twint: can a normal account create a QR code or payment code?

**No.** With a standard/private Twint account you cannot generate a Twint QR code,
QR-code sticker or payment link for your shop.

- Private individuals cannot request the business QR-code sticker. The minimum
  requirement for a Twint business account without a commercial-register entry is a sole
  proprietorship, a simple partnership, or a club/Verein.
  ([Twint FAQ](https://www.twint.ch/faq/kann-ich-als-privatperson-einen-qr-code-sticker-beantragen/?lang=de))
- Sending money to friends cannot be triggered with a QR code; you need the recipient's
  phone number and name. QR and numeric payment codes are offered exclusively by
  commercial shops and merchants.
  ([Twint FAQ](https://www.twint.ch/faq/worauf-soll-ich-beim-senden-und-empfangen-von-geld-achten/))
- A business customer can use the Twint merchant/Business Portal to order QR-code
  stickers and payment links. QR codes can carry a freely selectable amount; payment
  links are intended for distance transactions.
  ([Twint payment link](https://www.twint.ch/geschaeftskunden/produkte/twint-im-onlineshop/zahlungslink/),
  [order FAQ](https://www.twint.ch/faq/wie-bestelle-ich-einen-zahlungslink-zahlbutton-oder-qr-code-fuer-postversand/?audience=business_customer))

What this means for the Snack-Shack:

- The current setup can show the Twint **phone number**; customers send the amount
  manually from their Twint app (there is no automatic reconciliation).
- A real QR code or payment link requires a Twint **business account**. A school club
  (“Verein”) can qualify. After registration, paste the payment link into
  `SHOP_CONFIG.twintLink`; the Twint dialog will show a button for it.
- Twint's guidance says payment links should not be shared publicly on social media or
  in mass mailings. For a public shop page, use the official business integration/QR
  sticker at the counter rather than posting a private-account number as a “payment
  code”.

## Security notes

- The public can read the inventory, create a reservation with a `-1` stock move, and
  create a wish. Everything else is admin-only.
- The reservation rule is intentionally narrow, but it still allows someone to reserve
  many units (stock denial) because no login is required. For a school snack shop this is
  usually acceptable. For stronger protection, enable **Firebase App Check** and/or move
  the reservation transaction into a Cloud Function and remove the public `update` branch
  from the inventory rules.
- The reservation documents contain optional names and phone numbers. They are readable
  only by the admin.
- The admin password is checked by Firebase Authentication, not by JavaScript.

## Quick test

1. Publish `firestore.rules`.
2. Open the page as a visitor: the opening badge should show the correct state.
3. Reserve one item; the quantity should drop by 1 immediately and a reservation should
   appear in the admin panel.
4. In the admin panel, **Stornieren** restores the unit; **Abgeholt** books the profit.
5. Submit a wish and check that it appears in the admin wishlist.
6. If the SMS function is deployed, check the phone; otherwise use the prepared SMS link.
