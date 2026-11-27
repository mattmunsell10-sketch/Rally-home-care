# Rally Care

Shared med schedules, tasks and a care log for families looking after an aging parent. The organizer starts a care circle in about a minute. Siblings and paid aides join by tapping a texted link: no account, no password, no app store.

- **Front end:** an installable web app (PWA) in `public/`, plain JavaScript with no build step. It keeps a local copy of the circle's data, so it opens instantly and works offline.
- **Back end:** one Cloudflare Worker (`src/worker.js`) with a D1 (SQLite) database. The tables create themselves on first use.
- **Billing:** Stripe Checkout, the Stripe customer portal, and webhooks (`src/stripe.js`). Family Plus costs $6.99/month or $59/year per circle and comes with a 14-day free trial.

Hosting stays on Cloudflare's free tier (Workers, D1 and static assets) until there is real traction.

## How it works

| Piece | What it does |
| --- | --- |
| Care circle | One per parent. Roles: Organizer, Family, Aide (an aide doesn't see expenses). |
| Invite link `/j/<code>` | Works for 7 days and for anyone it's sent to. The role is set by whoever sends it. |
| "Use Rally on another phone" | A single-use link that's valid for 15 minutes and signs the same person in on a second device. |
| Device token | A random token is saved on the phone. The server stores only its SHA-256 hash. If an organizer removes someone, that person is signed out everywhere. |
| Records | Meds, doses, tasks, notes, expenses and shifts are JSON records that sync with last-write-wins. The app syncs every 30 seconds and whenever it's reopened. |
| Family Plus | Adds expense split, refill countdown and the doctor-visit summary. Only Stripe webhooks can change a circle's plan. |

## Run it locally

```bash
npm install
echo "STRIPE_WEBHOOK_SECRET=whsec_local_test" > .dev.vars
npm run dev          # http://localhost:8787
npm run smoke        # 27 end-to-end API checks against the dev server
```

To try checkout locally, add `STRIPE_SECRET_KEY=sk_test_...` to `.dev.vars`. Never commit that file.

## Deploy (one-time setup)

### Cloudflare

1. **Create the database:** go to Storage & Databases > D1 > Create, and name it `rally`. Done: its ID is already in `wrangler.jsonc`.
2. **Connect the repo:** go to Workers & Pages > Create > Import a repository, and pick `rally-home-care`. Keep the deploy command `npx wrangler deploy`. From then on, every push to `main` deploys.
3. Your app is live at `https://rally-home-care.<your-subdomain>.workers.dev`. You can add `rallycare.app` later under the Worker's Settings > Domains & Routes.

### Stripe (use test mode first)

1. **Secret key:** go to Developers > API keys and copy the secret key (`sk_test_...`). In Cloudflare, add it under the Worker's Settings > Variables and Secrets as a **Secret** named `STRIPE_SECRET_KEY`.
2. **Webhook:** go to Developers > Webhooks > Add endpoint, with
   - URL: `https://<your app>/api/stripe/webhook`
   - Events: `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.subscription.paused`, `customer.subscription.resumed`

   Copy the signing secret (`whsec_...`) into a Cloudflare secret named `STRIPE_WEBHOOK_SECRET`.
3. **Customer portal:** go to Settings > Billing > Customer portal, turn on cancel and update-payment-method, and click Save. Rally's "Manage subscription and invoices" button needs this.
4. **Invoices and receipts:** go to Settings > Billing > Subscriptions and emails, and turn on emails for successful payments and finalized invoices. Stripe then sends every subscriber an invoice automatically.
5. **Optional:** create a "Rally Family Plus" product with $6.99 monthly and $59 yearly prices, then set `STRIPE_PRICE_MONTHLY` and `STRIPE_PRICE_YEARLY` as plain variables. If you skip this, checkout creates the prices on the fly.

When you're ready to take real money, repeat the Stripe steps in live mode and swap both secrets.

## Next up

- Push reminders at dose time and missed-dose texts (Web Push, then Twilio for Plus)
- Weekly email digest and an email backup sign-in (Resend)
- Document vault and emergency QR card (R2)
- Calendar feed for shifts
