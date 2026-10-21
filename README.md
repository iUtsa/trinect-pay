# Trinect LLC payments

A small, static payment page for Trinect LLC. Customers pay an invoice or make another payment by card
through Stripe Payment Links. There is no server and no secret key on the site: it only holds the public
payment-link URLs in `docs/links.json`.

- `docs/` is the site (served by GitHub Pages): `index.html`, `thanks.html`, `style.css`, `links.json`.
- `setup/create-links.mjs` creates or updates the two Payment Links in Stripe and writes their URLs to
  `docs/links.json`. It needs Node 18 or newer.

## Set up or change the payment links

```sh
node setup/create-links.mjs                       # asks for the key, hidden
node setup/create-links.mjs < ~/stripe-key.txt    # or from a file
```

It finds links it made before and updates them, so running it again is safe. Amounts are customer-chosen,
from $1 to $50,000 (set `MIN_USD` / `MAX_USD` to change). A restricted key with write access to
Products, Prices and Payment Links is enough.

## What customers get

- Card payment on Stripe's checkout page, with the invoice number (or what the payment is for) required.
- Stripe's email receipt, if "Successful payments" receipts are on in Stripe → Settings → Customer emails.
- The thank-you page afterwards.

Every payment carries the metadata `business: trinect`, so it is easy to filter in the Stripe dashboard.
