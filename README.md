# SmartTutors72 website source

A custom writing-services storefront with a real Node.js backend, SQLite database, customer accounts, private uploads, order messages, administrator quotes, and optional Stripe Checkout.

**Business:** SmartTutors72 · United States · Worldwide service  
**Contact:** smarttutors72@gmail.com  
**Advertised starting price:** USD $10 per page

## Start on your computer

1. Install **Node.js 24 or later** from [nodejs.org](https://nodejs.org/). Node includes npm.
2. Extract this ZIP and open a terminal in the `smarttutors72` folder.
3. Run:

   ```sh
   npm start
   ```

4. Open **http://localhost:3000** in your browser.

There are no npm dependencies to install and no frontend build step. Do not double-click `public/index.html`: accounts and orders need the included server.

To change settings, copy `.env.example` to `.env` and edit it. On Windows, File Explorer may hide the leading-dot files; enable hidden-file visibility if needed. The default startup works without a `.env` file.

## Create your administrator account

In another terminal, in the same folder, run:

```sh
npm run create-admin
```

Enter your email and a password of at least 12 characters. The password is hidden as you type. There are no built-in accounts or default passwords. Using the command for an existing email updates that account and invalidates its existing sessions.

Log in at **http://localhost:3000/account**. Administrator accounts open the admin dashboard automatically.

## What is included

- Custom navy, ivory, teal, and gold design; authored SVG and CSS document artwork.
- Responsive home, services, individual service pages, pricing, process, about, contact, FAQ, and policy pages.
- Live starting-price calculator and a four-step quote-request form.
- Registration, login, logout, session cookies, and optional emailed password resets.
- Persistent customer orders, timelines, private file downloads, messages, revisions, and payment receipts.
- Admin order search, status/service/deadline filters, quote approval, customer listing, contact inbox, file delivery, and editable rates, service descriptions, and policies.
- Stripe-hosted card checkout with signature-verified webhooks and server-side price checks.
- Optional Resend transactional notifications and password-reset email.
- Automated integration tests, environment template, and optional Dockerfile.

## Pricing and business settings

The initial $10-per-page estimate applies to proofreading/editing, academic support, and content/copywriting. Business writing, career documents, and coaching start as custom-quote services. These service categories and the three eligible $10 starting rates are configurable implementation defaults based on the brief; confirm your actual catalog before launching.

Every new order starts as **Awaiting quote**. An administrator reviews the brief, discusses scope in the order messages, and confirms the full amount. A requested deadline is not automatically accepted. The browser estimate is never trusted for charging a customer.

**No words-per-page definition has been assumed.** Set your definition in Admin → Settings before confirming page-based quotes. The confirmed definition is saved to the order. Set the duration and scope of coaching sessions in the quote discussion.

Rates are stored in integer USD cents. Prices do not automatically add deadline surcharges, coupons, tax, or other extras. The administrator's confirmed amount is the total amount sent to checkout. Configure tax handling appropriate to your business before live sales if needed. If you change your $10 advertised minimum, also update the marketing copy in `public/app.js` and `public/index.html` to match your current offer.

## Connect Stripe payments

Start with Stripe **test** credentials. Set these in `.env` or your hosting provider's secret manager:

```dotenv
STRIPE_SECRET_KEY=your_stripe_test_secret_key
STRIPE_WEBHOOK_SECRET=your_stripe_test_webhook_secret
PAYMENTS_ENABLED=true
APP_ORIGIN=http://localhost:3000
```

1. Configure a Stripe webhook at `/api/stripe/webhook` on your server.
2. Subscribe to `checkout.session.completed` and `checkout.session.async_payment_succeeded`.
3. For local tests, use Stripe's official CLI forwarding workflow. Copy its webhook signing secret into the environment.
4. Set the words-per-page definition and publish your reviewed policies through Admin → Settings.
5. Create a customer order, confirm the quote as an admin, and open its payment action in the customer dashboard.
6. Verify payment, order status, delivery, and receipts in test mode before configuring live credentials and HTTPS.

Only signed, recent webhook events with the matching checkout session, order, quote version, USD currency, and exact total can mark an order paid. A success-page visit cannot mark it paid. Repeated delivery of a payment event does not create duplicate payment records.

This starter supports **Stripe card checkout**. PayPal and M-Pesa are not wired in. Card details are entered on Stripe's hosted checkout, not stored here. Failed or cancelled attempts leave the order unpaid; customers can reopen an active checkout or start another after expiration.

Once checkout begins, its quote amount is locked to prevent old payment links from settling a changed quote. If the scope changes, resolve the old payment session directly in Stripe and create a replacement order. Refunds are handled in Stripe; automatic refund/dispute synchronization and self-service order cancellation after checkout are not implemented.

## Connect email

Set `RESEND_API_KEY` and `EMAIL_FROM` using a verified sending domain in your Resend account. Your public contact and reply-to remain **smarttutors72@gmail.com**. A Gmail address does not establish a verified sending domain for Resend.

Without these settings:

- Contact forms still save to the admin Contact inbox.
- Orders and order messages still persist in the dashboards.
- No notification email is sent.
- Password reset explains that email is unavailable and directs the customer to support.

With the settings, the app emails the business when an order or contact inquiry arrives and supports single-use password-reset links. Routine order messages and status changes remain in the dashboard; they do not generate an email for every update.

## Policies and customer data

Policy fields are intentionally empty. Add your approved privacy, terms, refund, and revision wording in Admin → Settings, then publish them. Payment stays blocked until policies are published. An accepted policy snapshot is retained in the order when checkout begins. Revision requests are requests for review, not a promise of unlimited free revisions.

Files are stored outside the public directory with randomized names. Customer ownership is checked for every download and order endpoint. Upload limits are 10 MB per file, 20 files and 50 MB per order. Supported extensions are PDF, DOCX, TXT, MD, PPTX, XLSX, PNG, JPG, JPEG, and WEBP. Basic file signatures are checked. Downloads use attachment disposition.

Selected files stay in the browser until submission. An unfinished text draft is stored in that tab's session storage; passwords are never stored there. The draft is cleared after successful submission.

## Files you can edit

| File | Purpose |
| --- | --- |
| `public/index.html` | Shared header, footer, metadata, and application shell |
| `public/styles.css` | Colors, typography, layout, mobile breakpoints, and components |
| `public/app.js` | Page content, order forms, calculators, and dashboards |
| `public/favicon.svg` | Custom brand mark |
| `server.mjs` | HTTP routes, sessions, database, uploads, admin, and payment verification |
| `.env.example` | Configuration template; copy to `.env` locally |
| `test/app.test.mjs` | Integration checks using an isolated temporary database |
| `Dockerfile` | Optional container setup |

The app generates `data/smarttutors72.sqlite` and `data/uploads/` on first run. These are private runtime data and are not included in the source ZIP. Back up the database and uploads together; use SQLite-aware backups or stop the application while copying its data directory. Never commit `.env` or customer data.

## Hosting

Run this project on hosting that supports a **persistent Node.js process and writable disk**, or use the supplied Dockerfile. This is a Node/SQLite app; uploading only the HTML to a static host will not run accounts, orders, or payments.

Set:

```dotenv
NODE_ENV=production
HOST=0.0.0.0
PORT=3000
APP_ORIGIN=https://your-actual-domain.example
DATA_DIR=/your-persistent-data-directory
```

Replace the example domain with the real HTTPS origin, without a trailing slash or path. Place the server behind an HTTPS reverse proxy. Production cookies require HTTPS. If your reverse proxy overwrites `X-Forwarded-For`, you may set `TRUST_PROXY=true`; otherwise leave it false.

Run one application instance with this SQLite implementation. Add appropriate infrastructure for larger traffic. Configure backups, monitoring, storage retention, abuse prevention, and malware scanning before accepting untrusted production uploads. The included file signature checks do not replace malware scanning. Rate limits are per-process and reset at restart; account email verification and multi-factor authentication are not included.

Keep database and upload directories private. Never expose a directory listing. API keys stay on the server. The app includes origin/CSRF checks, scrypt password hashing, HttpOnly session cookies, role checks, and a restrictive content security policy; these are not a substitute for a deployment security review.

## Using this code with an AI website editor

Provide the source files and ask the editor to preserve the brand, API contracts, customer ownership checks, server-calculated quotes, and webhook verification. This is plain HTML/CSS/JavaScript with a Node backend, not a prebuilt Lovable/React/Supabase project. If your editor uses a different backend, it must port those server capabilities rather than replacing them with browser-only simulations.

## Verification

```sh
npm run check
npm test
```

The tests use disposable temporary data and stub external payment/email requests; they never charge a card or send a real email. They cover account validation, CSRF, ownership isolation, uploads, estimates, quotes, policy gates, checkout amount checks, webhook signatures and replays, delivery, revisions, contact persistence, and protected-source routes.

Desktop browser review covered the homepage, calculator, service selection, project details, upload step, and review gate. Live Stripe/Resend credentials were not supplied, so end-to-end provider transactions and real email delivery remain to be verified after configuration. The Docker image was not built in this environment.

## Official integration references

- [Node.js SQLite API](https://nodejs.org/download/release/latest-v24.x/docs/api/sqlite.html)
- [Stripe Checkout sessions](https://docs.stripe.com/api/checkout/sessions/create)
- [Stripe webhook verification](https://docs.stripe.com/events/manage-webhook-endpoints)
- [Resend email API](https://resend.com/docs/api-reference/emails/send-email)

Source prepared for SmartTutors72 on November 13, 2026.
