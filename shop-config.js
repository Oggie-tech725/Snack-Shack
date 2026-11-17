// Public shop settings — safe to publish (no secrets).
// Edit these values, then upload this file together with the rest of the site.
export const SHOP_CONFIG = {
  timeZone: "Europe/Zurich",

  // Shown in the Twint dialog and used for the SMS fallback link.
  contactPhone: "+41 76 501 68 35",
  twintNumber: "+41 76 501 68 35",

  // Where reservation SMS notifications go. The Cloud Function uses
  // SHOP_SMS_TO from functions/.env; keep both values in sync.
  smsTo: "+41775131586",
  smsToDisplay: "+41 77 513 15 86",

  // Optional: paste the URL printed by `firebase deploy --only functions`
  // (ends in ...cloudfunctions.net/notifyReservation or ...run.app).
  // Leave empty to use the one-tap "SMS senden" fallback instead.
  smsEndpoint: "",

  // Optional: a TWINT business payment link. A normal/private TWINT account
  // cannot create QR codes or payment links, so leave this empty until you
  // have a TWINT business account.
  twintLink: "",

  // Daily opening windows. The shop is open every day at these times.
  openingHours: [
    { start: "10:15", end: "10:30" },
    { start: "12:05", end: "13:00" },
    { start: "14:45", end: "14:55" }
  ],

  // Reservations can be made this many days ahead.
  reservationDaysAhead: 14,
  // A pickup window must still be open for at least this many minutes.
  reservationBufferMinutes: 5
};
