// The English string table, and the source of truth for what keys exist.
//
// `as const` is what makes MessageKey a union of the literal keys rather than
// `string`, so a typo in a t() call is a compile error. messages.so.ts then
// annotates itself `: Messages`, which turns a missing or stale Somali key into
// a compile error too -- see the comment there.
//
// Keys are `area.thing`, grouped in the order they appear on screen. Copy here
// is the corrected marketing copy: claims the product cannot meet were removed
// (there is no offline support), and figures reflect what the code actually
// enforces (see FREE_FALLBACK in lib/entitlements.ts).

export const en = {
  // ── document ──────────────────────────────────────────────────────────────
  'meta.title': 'Kaiibi — POS Built for Your Business',

  // ── language bar ──────────────────────────────────────────────────────────
  'langbar.tagline': 'Kaiibi speaks your language — Somali and English.',
  'langbar.short': 'Kaiibi speaks your language',
  'lang.label': 'Language',
  'lang.en': 'English',
  'lang.so': 'Soomaali',
  'lang.enShort': 'EN',
  'lang.soShort': 'SO',
  'lang.group': 'Language / Luqadda',

  // ── nav ───────────────────────────────────────────────────────────────────
  'nav.dashboard': 'Dashboard',
  'nav.features': 'Features',
  'nav.how': 'How it works',
  'nav.plans': 'Plans',
  'nav.faq': 'FAQ',
  'nav.signIn': 'Sign in',
  'nav.getStarted': 'Get started free',
  'nav.getStartedShort': 'Get started',
  'nav.menu': 'Menu',
  'nav.myShop': 'My shop',

  // ── hero ──────────────────────────────────────────────────────────────────
  'hero.eyebrow': 'Built for the Horn of Africa',
  'hero.title1': 'The POS built for',
  'hero.title2': 'your',
  'hero.title3': 'kind of business',
  'hero.lede':
    'Sell in USD, ETB or SLSH. Take cash, ZAAD, e-Dahab or another wallet. Track stock, staff and real profit — all from the phone in your pocket.',
  'hero.ledeShort':
    'Sell in any currency. Take cash, ZAAD or e-Dahab. Track stock, staff and real profit.',
  'hero.ctaPrimary': 'Get started free',
  'hero.ctaSecondary': 'See how it works',
  'hero.ctaDashboard': 'Go to your dashboard',
  'hero.note1': 'Free plan forever',
  'hero.note2': 'No card required',
  // "any smartphone", not "any Android phone": the app ships on iOS as well as
  // Android and runs in a browser on top of that. "Smartphone" rather than
  // "phone" because it genuinely won't run on a feature phone.
  'hero.note3': 'Works on any smartphone',

  // ── hero phone mock ───────────────────────────────────────────────────────
  'phone.takings': "Today's takings",
  'phone.salesMeta': '12 sales · 3 payment methods',
  'phone.profitWeek': 'Profit this week',
  'phone.netMargin': 'Net margin',
  'phone.paymentMethods': 'Payment methods',
  'phone.cash': 'Cash',
  'phone.sales7': '7 sales',
  'phone.sales3': '3 sales',
  'phone.sales2': '2 sales',
  'phone.goalOf': 'of $1,500.00 monthly goal',
  'phone.insight': "↗ Cold brew earns you the most — 38% of this week's profit.",
  'phone.newSale': 'New sale',

  // ── trust strip ───────────────────────────────────────────────────────────
  'trust.shops': 'Shops',
  'trust.pharmacies': 'Pharmacies',
  'trust.electronics': 'Electronics',
  'trust.wholesalers': 'Wholesalers',

  // ── dashboard preview ─────────────────────────────────────────────────────
  'dash.tag': 'The dashboard',
  'dash.title': 'Your whole shop, on one screen',
  'dash.lede':
    'Open Kaiibi in the morning and you already know where you stand — takings, costs, real profit and what needs fixing.',
  'dash.greeting': 'Good morning 👋',
  'dash.greetingSub': 'You kept $262.20 in profit this week — up 18% on last week.',
  'dash.range': '7 days',
  'dash.revenue': 'Revenue',
  'dash.revenueHint': 'net of tax & refunds',
  'dash.expenses': 'Expenses',
  'dash.expensesHint': 'operating',
  'dash.netProfit': 'Net profit',
  'dash.netProfitHint': '20% margin',
  'dash.orders': 'Orders',
  'dash.ordersHint': '$30.58 average sale',
  'dash.revenueWeek': 'Revenue this week',
  'dash.paymentMethods': 'Payment methods',
  'dash.cash': 'Cash',
  'dash.pnl': 'Profit & loss',
  'dash.pnlRevenue': 'Revenue',
  'dash.pnlCogs': 'Cost of goods',
  'dash.pnlGross': 'Gross profit',
  'dash.pnlOpex': 'Operating expenses',
  'dash.pnlNet': 'Net profit',
  'dash.goal': 'Monthly goal',
  'dash.goalOf': 'of $1,500.00 goal',
  'dash.worthKnowing': 'Worth knowing',
  'dash.insight':
    '💡 Cold brew brings in 38% of your profit on 19% of sales. Three items are running low — reorder before the weekend.',
  'dash.caption': 'Sample data — your dashboard shows your own numbers, in Somali or English.',

  // ── features ──────────────────────────────────────────────────────────────
  'features.tag': 'Features',
  'features.title': 'Everything your store needs',
  'features.lede':
    'One app for selling, stock, staff and the numbers that tell you whether you actually made money.',
  'features.pos.title': 'Fast point of sale',
  'features.pos.body':
    'Ring up a sale in seconds. Search by name, scan a barcode, or tap a favourite item.',
  'features.stock.title': 'Stock that stays right',
  'features.stock.body':
    'Stock drops the moment you sell. Get warned before a fast seller runs out.',
  'features.profit.title': 'Real profit, not guesswork',
  'features.profit.body':
    'Set what each item cost you and Kaiibi shows true margin — not just what came through the till.',
  'features.money.title': 'Multi-currency & mobile money',
  'features.money.body':
    'USD, ETB and SLSH side by side. Cash, ZAAD, e-Dahab and other wallets all recorded properly.',
  'features.discounts.title': 'Discounts and promotions',
  'features.discounts.body':
    'Run a price cut for a weekend or a bundle deal, and see afterwards if it was worth it.',
  'features.staff.title': 'Staff and permissions',
  'features.staff.body':
    'Give each cashier their own login. Decide who can discount, refund or see the profit.',
  'features.receipts.title': 'Receipts customers keep',
  'features.receipts.body':
    'Print, or send a receipt straight to WhatsApp — handy when someone comes back to return an item.',
  'features.customers.title': 'Know your customers',
  'features.customers.body':
    'See who buys often, what they buy, and who has not been in for a while.',
  'features.branches.title': 'Every branch in one place',
  'features.branches.body':
    "Move stock between stores, see what each one took, and switch the till to whichever counter you're standing at.",

  // ── how it works ──────────────────────────────────────────────────────────
  'how.tag': 'How it works',
  'how.title': 'Selling by this afternoon',
  'how.lede': 'No installer, no consultant, no training week. Three steps and you are trading.',
  'how.step1.title': 'Create your shop',
  'how.step1.body':
    'Sign up with a phone number, name your shop and pick your currency. Under two minutes.',
  'how.step2.title': 'Add what you sell',
  'how.step2.body':
    'Type items in, or import a list. Add the cost price too so profit is right from day one.',
  'how.step3.title': 'Start selling',
  'how.step3.body':
    'Take your first sale and watch the numbers build. Add cashiers whenever you are ready.',

  // ── stats ─────────────────────────────────────────────────────────────────
  'stats.currencies.value': 'Any',
  'stats.currencies.label': 'Currency you sell in',
  'stats.methods.value': '4',
  'stats.methods.label': 'Payment methods',
  'stats.languages.value': '2',
  'stats.languages.label': 'Languages',
  'stats.cost.value': '$0',
  'stats.cost.label': 'To get started',

  // ── plans ─────────────────────────────────────────────────────────────────
  'plans.tag': 'Plans',
  'plans.title': 'Pick the plan that fits your shop',
  'plans.lede':
    'Start on Free and stay there as long as you like, or take the Trial to see everything. Pricing for Standard and Pro will be announced soon.',
  'plans.mostPopular': 'Most popular',

  'plans.free.name': 'Free',
  'plans.free.for': 'For a new shop finding its feet',
  'plans.free.price': 'Free — always',
  'plans.free.priceNote': 'No card, no trial clock',
  'plans.free.f1': 'Point of sale on one device',
  'plans.free.f2': 'Product and stock list',
  'plans.free.f3': 'Daily sales summary',
  'plans.free.f4': 'Cash, ZAAD, e-Dahab',
  'plans.free.f5': 'Up to 50 products and 300 sales a month',
  'plans.free.cta': 'Start free',

  'plans.trial.name': 'Trial',
  'plans.trial.for': 'Try every Pro feature, free',
  'plans.trial.price': 'Free trial',
  'plans.trial.priceNote': 'Length announced at launch',
  'plans.trial.f1': 'Everything Pro can do',
  'plans.trial.f2': 'No card to start',
  'plans.trial.f3': 'Keep your data after it ends',
  'plans.trial.f4': 'Drop to Free any time',
  'plans.trial.cta': 'Start trial',

  'plans.standard.name': 'Standard',
  'plans.standard.for': 'For a busy shop with a small team',
  'plans.standard.price': 'Pricing coming soon',
  'plans.standard.priceNote': 'We will announce it before launch',
  'plans.standard.f1': 'Everything in Free',
  'plans.standard.f2': 'Multiple cashiers with logins',
  'plans.standard.f3': 'Cost prices and true profit',
  'plans.standard.f4': 'Discounts and promotions',
  'plans.standard.f5': 'Customer records',
  'plans.standard.f6': 'WhatsApp receipts',
  'plans.standard.cta': 'Start free',

  'plans.pro.name': 'Pro',
  'plans.pro.for': 'For several branches and bigger teams',
  'plans.pro.price': 'Pricing coming soon',
  'plans.pro.priceNote': 'Talk to us about your setup',
  'plans.pro.f1': 'Everything in Standard',
  'plans.pro.f2': 'Multiple branches in one view',
  'plans.pro.f3': 'Unlimited staff accounts',
  'plans.pro.f4': 'Full accounting and reports',
  'plans.pro.f5': 'Payroll and time off',
  'plans.pro.f6': 'Priority support',
  'plans.pro.cta': 'Email us',

  // ── reviews (component written, not mounted — see landing-reviews.tsx) ─────
  'reviews.tag': 'Reviews',
  'reviews.title': 'Shopkeepers who switched',

  // ── faq ───────────────────────────────────────────────────────────────────
  'faq.tag': 'FAQ',
  'faq.title': 'Common questions',
  'faq.q1': 'What does the Free plan actually cost?',
  'faq.a1':
    'Nothing, and there is no trial timer on it. You can run your shop on Free for as long as it suits you, up to 50 products and 300 sales a month.',
  'faq.q2': 'How much will Standard and Pro cost?',
  'faq.a2':
    'We are still setting the prices. They will be published here before those plans go on sale.',
  'faq.q3': 'Can more than one person use it at once?',
  'faq.a3':
    'Yes. Each cashier gets their own login, and you decide who can discount, refund or see the profit. Two tills at the same counter share the same stock.',
  'faq.q4': 'Can I use it in Somali?',
  'faq.a4':
    'The website and sign-up are in Somali and English today, and the rest of the app is being translated next.',
  'faq.q5': 'Do I need special hardware?',
  'faq.a5':
    'No. An ordinary smartphone is enough to start. Add a barcode scanner, receipt printer or cash drawer later if you want them.',
  'faq.q6': 'What happens to my data if I stop using Kaiibi?',
  'faq.a6':
    'It stays yours. You can export your sales, products and customers to a spreadsheet at any time.',

  // ── closing cta ───────────────────────────────────────────────────────────
  'cta.title': 'Ready to run your shop smarter?',
  'cta.lede':
    'Start free today. Add your team and your numbers when you are ready — no card, no commitment.',
  'cta.primary': 'Get started free',
  'cta.secondary': 'Email us',

  // ── footer ────────────────────────────────────────────────────────────────
  'footer.blurb':
    'Point-of-sale and accounting built for retail businesses in the Horn of Africa.',
  'footer.product': 'Product',
  'footer.support': 'Support',
  'footer.company': 'Company',
  'footer.getStarted': 'Get started',
  'footer.emailUs': 'Email us',
  'footer.about': 'About',
  'footer.privacy': 'Privacy policy',
  'footer.copyright': '© {year} Kaiibi. All rights reserved.',

  // ── about ─────────────────────────────────────────────────────────────────
  'about.eyebrow': 'Kaiibi · POS & inventory',
  'about.title': 'A simpler way to run your store.',
  'about.intro':
    'Kaiibi gives store owners a fast till, real-time inventory, and daily sales insight — all in one simple app.',
  'about.builtFor': 'Built for store owners',
  'about.owner.title': 'Run your store, end to end',
  'about.owner.body':
    'Ring up sales, keep stock organized, and see what’s selling — all from your phone or browser.',
  'about.owner.need': 'You need: a simple till, clear inventory, and real numbers.',
  'about.gettingStarted': 'Getting started',
  'about.stepsTitle': 'Set up your store in four simple steps.',
  'about.step1.title': 'Create your store',
  'about.step1.body':
    'Add your store name, location, contact details, and a short introduction so customers know who you are.',
  'about.step2.title': 'Add your first products',
  'about.step2.body':
    'For every item, upload a photo, name it, set a price, choose a category, and write a useful description.',
  'about.step3.title': 'Organize your inventory',
  'about.step3.body':
    'Set the quantity you have available and add tags such as handmade, groceries, or home. Update stock as items sell.',
  'about.step4.title': 'Keep your storefront current',
  'about.step4.body':
    'Review low-stock items, add new arrivals, and make sure product photos and prices stay accurate.',
  'about.mission.tag': 'The MVP',
  'about.mission.title': 'Built to work for any store, anywhere.',
  'about.mission.body':
    'We are starting with a focused, easy-to-use POS and inventory system for store owners. An online marketplace for customers is coming later.',

  // ── login ─────────────────────────────────────────────────────────────────
  'login.createShop': 'Create a shop',
  'login.howItWorks': 'How it works',
  'login.welcomeBack': 'Welcome back',
  'login.email': 'Email',
  'login.emailPlaceholder': 'you@example.com',
  'login.password': 'Password',
  'login.passwordPlaceholder': 'Your password',
  'login.submit': 'Log in',
  'login.submitting': 'Logging in…',
  'login.error': 'Could not log in. Check your email and password.',

  // ── signup ────────────────────────────────────────────────────────────────
  'signup.eyebrow': 'Kaiibi',
  'signup.title': 'Create your shop account.',
  'signup.lede': 'We will get your shop ready in a few quick steps.',
  'signup.progress': 'Step {step} of {total}',
  'signup.back': '← Back',
  'signup.step1': 'First, your details',
  'signup.yourName': 'Your name',
  'signup.yourNamePlaceholder': 'Full name',
  'signup.phone': 'Phone or WhatsApp',
  'signup.phonePlaceholder': 'e.g. +252 63 000 0000',
  'signup.email': 'Email',
  'signup.emailPlaceholder': 'you@example.com',
  'signup.password': 'Password',
  'signup.passwordPlaceholder': 'At least 6 characters',
  'signup.step2': 'Tell us about your shop',
  'signup.shopName': 'Shop name',
  'signup.shopNamePlaceholder': 'Your shop name',
  'signup.step3': 'Where is your shop?',
  'signup.city': 'City',
  'signup.cityPlaceholder': 'Hargeisa',
  'signup.neighborhood': 'Neighborhood or landmark',
  'signup.neighborhoodPlaceholder': 'e.g. Jigjiga Yar, near the main market',
  'signup.create': 'Create account',
  'signup.creating': 'Creating…',
  'signup.error': 'Something went wrong. Please try again.',
  'signup.haveShop': 'Already have a shop? Log in',
  'signup.termsBefore':
    'By continuing, you agree to use Kaiibi respectfully, keep your information accurate, and accept our',
  'signup.privacy': 'Privacy Policy',

  // ── shared ────────────────────────────────────────────────────────────────
  'common.back': 'Back',
  'common.continue': 'Continue',
} as const;

export type MessageKey = keyof typeof en;

/**
 * Every locale supplies exactly this key set — no more, no less.
 *
 * A table annotated `: Messages` fails to compile if a key is MISSING
 * ("Property 'x' is missing") or STALE (excess-property error on the object
 * literal). `satisfies` would not catch the missing case the same way, which
 * is why this is a plain annotation.
 */
export type Messages = Record<MessageKey, string>;
