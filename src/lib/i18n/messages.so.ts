import type { Messages } from '@/lib/i18n/messages.en';

// Somali (Af-Soomaali). Latin script, so there is no RTL work anywhere in the
// app -- if you find yourself reaching for I18nManager, the reason isn't this
// language.
//
// The `: Messages` annotation is load-bearing: add a key to messages.en.ts and
// this file stops compiling until it is translated, remove one and the stale
// entry here is an excess-property error. Never widen it to `Record<string,
// string>` or the whole guarantee goes away.

export const so: Messages = {
  // ── document ──────────────────────────────────────────────────────────────
  'meta.title': 'Kaiibi — Nidaamka Iibka ee Ganacsigaaga',

  // ── language bar ──────────────────────────────────────────────────────────
  'langbar.tagline': 'Kaiibi wuxuu ku hadlaa luqaddaada — Soomaali iyo Ingiriisi.',
  'langbar.short': 'Kaiibi wuxuu ku hadlaa luqaddaada',
  'lang.label': 'Luqadda',
  'lang.en': 'English',
  'lang.so': 'Soomaali',
  'lang.enShort': 'EN',
  'lang.soShort': 'SO',
  'lang.group': 'Language / Luqadda',

  // ── nav ───────────────────────────────────────────────────────────────────
  'nav.dashboard': 'Shaashadda',
  'nav.features': 'Astaamaha',
  'nav.how': 'Sida uu u shaqeeyo',
  'nav.plans': 'Qorshayaasha',
  'nav.faq': "Su'aalaha",
  'nav.signIn': 'Gal',
  'nav.getStarted': 'Bilaash ku bilow',
  'nav.getStartedShort': 'Bilow',
  'nav.menu': 'Liiska',
  'nav.myShop': 'Dukaankayga',
  'nav.shops': 'Dukaamada',

  // ── hero ──────────────────────────────────────────────────────────────────
  'hero.eyebrow': 'Loogu talagalay Geeska Afrika',
  'hero.title1': 'Nidaamka iibka ee loogu talagalay',
  'hero.title2': 'ganacsigaaga',
  'hero.title3': 'nooca aad leedahay',
  'hero.lede':
    "Ku iibi USD, ETB ama SLSH. Aqbal lacag caddaan ah, ZAAD, e-Dahab ama wallet kale. La soco alaabta, shaqaalaha iyo faa'iidada dhabta ah — dhammaan taleefankaaga.",
  'hero.ledeShort':
    "Ku iibi lacag kasta. Aqbal caddaan, ZAAD ama e-Dahab. La soco alaabta, shaqaalaha iyo faa'iidada.",
  'hero.ctaPrimary': 'Bilow tijaabada bilaashka ah',
  'hero.ctaSecondary': 'Arag sida uu u shaqeeyo',
  'hero.ctaDashboard': 'Aad shaashaddaada',
  'hero.note1': 'Astaamaha oo dhan inta tijaabadu socoto',
  'hero.note2': "Kaadh looma baahna",
  'hero.note3': 'Wuxuu ku shaqeeyaa taleefan casri ah kasta',

  // ── hero phone mock ───────────────────────────────────────────────────────
  'phone.takings': 'Iibka maanta',
  'phone.salesMeta': '12 iib · 3 hab lacag-bixin',
  'phone.profitWeek': "Faa'iidada usbuucan",
  'phone.netMargin': "Faa'iido boqolkiiba",
  'phone.paymentMethods': 'Habka lacag-bixinta',
  'phone.cash': 'Lacag caddaan',
  'phone.sales7': '7 iib',
  'phone.sales3': '3 iib',
  'phone.sales2': '2 iib',
  'phone.goalOf': 'oo ka mid ah $1,500.00 bishii',
  'phone.insight': "↗ Cold brew ayaa ugu faa'iido badan — 38% faa'iidada usbuucan.",
  'phone.newSale': 'Iib cusub',

  // ── trust strip ───────────────────────────────────────────────────────────
  'trust.shops': 'Dukaamada',
  'trust.pharmacies': 'Farmasiyada',
  'trust.electronics': 'Elektarooniga',
  'trust.wholesalers': 'Jumladlayaasha',

  // ── dashboard preview ─────────────────────────────────────────────────────
  'dash.tag': 'Shaashadda guud',
  'dash.title': 'Dukaankaaga oo dhan, hal shaashad',
  'dash.lede':
    "Subaxdii fur Kaiibi waxaad hore u ogaan doontaa halka aad taagan tahay — iibka, kharashka, faa'iidada dhabta ah iyo waxa u baahan hagaajin.",
  'dash.greeting': 'Subax wanaagsan 👋',
  'dash.greetingSub': "Usbuucan waxaad haysataa faa'iido $262.20 ah — 18% ka badan usbuucii hore.",
  'dash.range': '7 maalmood',
  'dash.revenue': 'Dakhliga',
  'dash.revenueHint': 'canshuur iyo celin ka baxsan',
  'dash.expenses': 'Kharashka',
  'dash.expensesHint': 'hawlgal',
  'dash.netProfit': "Faa'iidada saafiga",
  'dash.netProfitHint': "20% faa'iido",
  'dash.orders': 'Iibka',
  'dash.ordersHint': '$30.58 celcelis iib',
  'dash.revenueWeek': 'Dakhliga usbuucan',
  'dash.paymentMethods': 'Habka lacag-bixinta',
  'dash.cash': 'Lacag caddaan',
  'dash.pnl': "Faa'iido & khasaare",
  'dash.pnlRevenue': 'Dakhliga',
  'dash.pnlCogs': 'Qiimaha alaabta',
  'dash.pnlGross': "Faa'iidada guud",
  'dash.pnlOpex': 'Kharashka hawlgalka',
  'dash.pnlNet': "Faa'iidada saafiga",
  'dash.goal': 'Bartilmaameedka bishii',
  'dash.goalOf': 'oo ka mid ah $1,500.00',
  'dash.worthKnowing': 'Waxaa fiican inaad ogaato',
  'dash.insight':
    "💡 Cold brew wuxuu keenaa 38% faa'iidadaada isagoo ah 19% iibka. Saddex alaab ayaa ku dhow inay dhammaadaan — dalbo ka hor toddobaadka dhammaadkiisa.",
  'dash.caption':
    'Xog tusaale ah — shaashaddaadu waxay tusaysaa tirooyinkaaga, Af-Soomaali ama Ingiriisi.',

  // ── features ──────────────────────────────────────────────────────────────
  'features.tag': 'Astaamaha',
  'features.title': 'Wax kasta oo dukaankaagu u baahan yahay',
  'features.lede':
    "Hal barnaamij oo loogu talagalay iibka, alaabta, shaqaalaha iyo tirooyinka kuu sheegaya inaad dhab ahaan faa'iido samaysay.",
  'features.pos.title': 'Iib degdeg ah',
  'features.pos.body':
    'Iib ku dhammee ilbiriqsiyo. Ku raadi magaca, iskaan garee barcode-ka, ama taabo alaab aad badanaa iibiso.',
  'features.stock.title': 'Alaab had iyo jeer sax ah',
  'features.stock.body':
    'Alaabtu way yaraataa isla markaad iibiso. Waa lagu digayaa ka hor inta aysan dhammaan alaabta si dhaqso ah u baxda.',
  'features.profit.title': "Faa'iido dhab ah, ma aha mala-awaal",
  'features.profit.body':
    "Geli qiimaha aad ku soo iibsatay alaab kasta, Kaiibina wuxuu ku tusayaa faa'iidada dhabta ah — ma aha oo kaliya lacagta soo gashay.",
  'features.money.title': 'Lacago kala duwan & lacagta mobilada',
  'features.money.body':
    'USD, ETB iyo SLSH oo wada socda. Lacag caddaan, ZAAD, e-Dahab iyo wallet kale oo si sax ah loo diiwaangeliyo.',
  'features.discounts.title': 'Qiimo-dhimis iyo dallacaad',
  'features.discounts.body':
    "Samee qiimo-dhimis toddobaadle ah ama xirmo wadajir ah, kadibna arag inay faa'iido lahayd iyo in kale.",
  'features.staff.title': 'Shaqaalaha iyo oggolaanshaha',
  'features.staff.body':
    "Sii khasnaji kasta akoon u gaar ah. Go'aanso cidda qiimo dhimi karta, lacag celin karta ama faa'iidada arki karta.",
  'features.receipts.title': 'Rasiidyo macaamiishu hayaan',
  'features.receipts.body':
    "Daabac, ama toos ugu dir rasiid WhatsApp — waa faa'iido marka qof soo celinayo alaab.",
  'features.customers.title': 'Baro macaamiishaada',
  'features.customers.body':
    'Arag cidda badanaa wax iibsata, waxay iibsadaan, iyo cidda muddo aan imaan.',
  'features.branches.title': 'Laamaha oo dhan hal meel',
  'features.branches.body':
    "Alaabta u wareeji dukaan kale, arag waxa mid kasta soo galiyay, oo u beddel khasnadda meesha aad taagan tahay.",

  // ── how it works ──────────────────────────────────────────────────────────
  'how.tag': 'Sida uu u shaqeeyo',
  'how.title': 'Galabta ayaad iibin kartaa',
  'how.lede':
    'Ma jiro rakibid adag, lataliye, ama toddobaad tababar ah. Saddex tallaabo ayaad ku bilaabaysaa.',
  'how.step1.title': 'Samee dukaankaaga',
  'how.step1.body':
    'Isku diiwaangeli lambar taleefan, magacaw dukaankaaga oo dooro lacagta. Wax ka yar laba daqiiqo.',
  'how.step2.title': 'Ku dar waxaad iibiso',
  'how.step2.body':
    "Ku qor alaabta, ama soo dhoofi liis. Ku dar qiimaha aad ku soo iibsatay si faa'iidadu u saxsanaato maalinta koowaad.",
  'how.step3.title': 'Bilow iibinta',
  'how.step3.body':
    'Qaado iibkaaga koowaad oo daawo tirooyinka oo kordhaya. Ku dar khasnajiyo markaad diyaar tahay.',

  // ── stats ─────────────────────────────────────────────────────────────────
  'stats.currencies.value': 'Mid kasta',
  'stats.currencies.label': 'Lacagta aad ku iibiso',
  'stats.methods.value': '4',
  'stats.methods.label': 'Habab lacag-bixin',
  'stats.languages.value': '2',
  'stats.languages.label': 'Luqado',
  'stats.cost.value': '$0',
  'stats.cost.label': 'Si aad u bilowdo',

  // ── plans ─────────────────────────────────────────────────────────────────
  'plans.tag': 'Qorshayaasha',
  'plans.title': 'Dooro qorshaha ku habboon dukaankaaga',
  'plans.lede':
    'Qaado Tijaabada si aad wax walba u aragto, kadibna dooro qorshaha kugu habboon. Qiimaha Caadiga iyo Pro dhawaan ayaa la shaacin doonaa.',
  'plans.mostPopular': 'Ugu caansan',

  'plans.trial.name': 'Tijaabo',
  'plans.trial.for': 'Tijaabi dhammaan astaamaha Pro, bilaash',
  'plans.trial.price': 'Tijaabo bilaash ah',
  'plans.trial.priceNote': 'Muddada waa la shaacinayaa bilowga',
  'plans.trial.f1': 'Wax kasta oo Pro qaban karo',
  'plans.trial.f2': 'Kaadh looma baahna bilowga',
  'plans.trial.f3': 'Xogtaada way kuu haraysaa markuu dhammaado',
  'plans.trial.f4': 'Ballan-qaad kuma saarna markuu dhammaado',
  'plans.trial.cta': 'Bilow tijaabada',

  'plans.standard.name': 'Caadi',
  'plans.standard.for': 'Dukaan mashquul ah oo koox yar leh',
  'plans.standard.price': 'Qiimaha dhawaan',
  'plans.standard.priceNote': 'Waan shaacin doonaa ka hor bilowga',
  'plans.standard.f1': 'Iib, alaab iyo bakhaar',
  'plans.standard.f2': 'Khasnajiyo badan oo akoon leh',
  'plans.standard.f3': "Qiimaha kharashka iyo faa'iidada dhabta ah",
  'plans.standard.f4': 'Qiimo-dhimis iyo dallacaad',
  'plans.standard.f5': 'Diiwaanka macaamiisha',
  'plans.standard.f6': 'Rasiidyo WhatsApp',
  'plans.standard.cta': 'Bilow',

  'plans.pro.name': 'Pro',
  'plans.pro.for': 'Laamo badan iyo kooxo waaweyn',
  'plans.pro.price': 'Qiimaha dhawaan',
  'plans.pro.priceNote': 'Nala soo hadal xaaladdaada',
  'plans.pro.f1': 'Wax kasta oo Caadiga ku jira',
  'plans.pro.f2': 'Laamo badan hal meel laga arko',
  'plans.pro.f3': 'Akoonno shaqaale oo aan xad lahayn',
  'plans.pro.f4': 'Xisaabaad buuxda iyo warbixino',
  'plans.pro.f5': 'Mushaharka iyo fasaxa',
  'plans.pro.f6': 'Taageero mudnaan leh',
  'plans.pro.cta': 'Iimayl noo dir',

  // ── reviews ───────────────────────────────────────────────────────────────
  'reviews.tag': 'Aragtiyaha',
  'reviews.title': 'Dukaanleyaal beddelay',

  // ── faq ───────────────────────────────────────────────────────────────────
  'faq.tag': "Su'aalaha",
  'faq.title': "Su'aalaha badanaa la weydiiyo",
  'faq.q1': 'Ma jirtaa tijaabo bilaash ah?',
  'faq.a1':
    'Haa. Waxaad tijaabin kartaa wax kasta oo Pro qaban karo adigoon kaadh isticmaalin, muddadana waa la shaacin doonaa bilowga. Xogtaadu way kuu haraysaa markay tijaabadu dhammaato.',
  'faq.q2': 'Caadiga iyo Pro imisa ayay noqon doonaan?',
  'faq.a2':
    'Weli qiimaha waan dejinaynaa. Halkan ayaa lagu daabici doonaa ka hor inta aan qorshayaashaas la bixin.',
  'faq.q3': 'Ma isticmaali karaan hal mar in ka badan hal qof?',
  'faq.a3':
    "Haa. Khasnaji kastaa wuxuu leeyahay akoon u gaar ah, adigaana go'aamisa cidda qiimo dhimi karta, lacag celin karta ama faa'iidada arki karta. Laba khasnadood oo isku counter ah waxay wadaagaan isla alaabta.",
  'faq.q4': "Ma ku isticmaali karaa Af-Soomaali?",
  'faq.a4':
    'Bogga iyo diiwaangelintu maanta waxay ku jiraan Af-Soomaali iyo Ingiriisi, inta kalena waa la turjumayaa.',
  'faq.q5': 'Ma u baahanahay qalab gaar ah?',
  'faq.a5':
    'Maya. Taleefan casri ah oo caadi ah ayaa ku filan bilowga. Waxaad markii dambe ku dari kartaa iskaanka barcode-ka, daabacaha rasiidka ama sanduuqa lacagta haddaad rabto.',
  'faq.q6': 'Maxaa ku dhacaya xogtayda haddaan joojiyo isticmaalka Kaiibi?',
  'faq.a6':
    'Adigaa iska leh. Waqti kasta waxaad u soo saari kartaa iibkaaga, alaabtaada iyo macaamiishaada xaashi xisaabeed.',

  // ── closing cta ───────────────────────────────────────────────────────────
  'cta.title': 'Ma diyaar u tahay inaad si caqli badan dukaankaaga u maamusho?',
  'cta.lede':
    'Maanta bilaash ku bilow. Ku dar kooxdaada iyo xogtaada markaad diyaar tahay — kaadh ma leh, ballanqaad ma leh.',
  'cta.primary': 'Bilaash ku bilow',
  'cta.secondary': 'Iimayl noo dir',

  // ── footer ────────────────────────────────────────────────────────────────
  'footer.blurb':
    'Nidaam iib iyo xisaabaad oo loogu talagalay ganacsiyada tafaariiqda ee Geeska Afrika.',
  'footer.product': 'Alaabta',
  'footer.support': 'Taageero',
  'footer.company': 'Shirkadda',
  'footer.getStarted': 'Bilow',
  'footer.emailUs': 'Iimayl noo dir',
  'footer.about': 'Ku saabsan',
  'footer.privacy': 'Siyaasadda asturnaanta',
  'footer.copyright': '© {year} Kaiibi. Xuquuqda oo dhan waa la dhawray.',

  // ── about ─────────────────────────────────────────────────────────────────
  'about.eyebrow': 'Kaiibi · Iib & alaab',
  'about.title': 'Hab ka fudud oo aad dukaankaaga ku maamusho.',
  'about.intro':
    "Kaiibi wuxuu dukaanleyda siiyaa khasnad dhaqso ah, alaab la socoto waqtiga dhabta ah, iyo aragti iib maalinle ah — dhammaan hal barnaamij.",
  'about.builtFor': 'Loogu talagalay dukaanleyda',
  'about.owner.title': 'Maamul dukaankaaga, bilow ilaa dhammaad',
  'about.owner.body':
    'Iibi, alaabta si hagaagsan u hay, oo arag waxa iibinaya — dhammaan taleefankaaga ama browserkaaga.',
  'about.owner.need': 'Waxaad u baahan tahay: khasnad fudud, alaab cad, iyo tirooyin dhab ah.',
  'about.gettingStarted': 'Sida loo bilaabo',
  'about.stepsTitle': 'Dukaankaaga ku dejiso afar tallaabo oo fudud.',
  'about.step1.title': 'Samee dukaankaaga',
  'about.step1.body':
    'Ku dar magaca dukaanka, goobta, xiriirka, iyo hordhac gaaban si macaamiishu u ogaadaan cidda aad tahay.',
  'about.step2.title': 'Ku dar alaabtaada koowaad',
  'about.step2.body':
    'Alaab kasta, sawir soo geli, magacaw, qiimo u dhig, dooro qayb, oo qor faahfaahin faa\'iido leh.',
  'about.step3.title': 'Habee alaabtaada',
  'about.step3.body':
    'Dhig tirada aad haysato oo ku dar summado sida gacan-samays, raashin, ama guri. Cusbooneysii marka alaabtu iibsato.',
  'about.step4.title': 'Dukaankaaga cusub ka dhig',
  'about.step4.body':
    'Dib u eeg alaabta yaraatay, ku dar kuwa cusub, oo hubi in sawirrada iyo qiimayaashu sax yihiin.',
  'about.mission.tag': 'MVP-ga',
  'about.mission.title': 'Loo dhisay in uu u shaqeeyo dukaan kasta, meel kasta.',
  'about.mission.body':
    'Waxaan ku bilownay nidaam iib iyo alaab oo fudud oo loogu talagalay dukaanleyda. Suuq internet oo macaamiisha ah ayaa markii dambe imanaya.',

  // ── login ─────────────────────────────────────────────────────────────────
  'login.createShop': 'Samee dukaan',
  'login.howItWorks': 'Sida uu u shaqeeyo',
  'login.welcomeBack': 'Ku soo dhawow',
  'login.email': 'Iimayl',
  'login.emailPlaceholder': 'adiga@tusaale.com',
  'login.password': 'Furaha sirta',
  'login.passwordPlaceholder': 'Furahaaga sirta',
  'login.submit': 'Gal',
  'login.submitting': 'Waa la galayaa…',
  'login.error': 'Ma geli karin. Hubi iimaylkaaga iyo furahaaga sirta.',

  // ── signup ────────────────────────────────────────────────────────────────
  'signup.eyebrow': 'Kaiibi',
  'signup.title': 'Samee akoonka dukaankaaga.',
  'signup.lede': 'Dhawr tallaabo oo dhaqso ah ayaan dukaankaaga ku diyaarinaynaa.',
  'signup.progress': 'Tallaabada {step} ee {total}',
  'signup.back': '← Dib u noqo',
  'signup.step1': 'Marka hore, faahfaahintaada',
  'signup.yourName': 'Magacaaga',
  'signup.yourNamePlaceholder': 'Magaca oo buuxa',
  'signup.phone': 'Taleefan ama WhatsApp',
  'signup.phonePlaceholder': 'tusaale +252 63 000 0000',
  'signup.email': 'Iimayl',
  'signup.emailPlaceholder': 'adiga@tusaale.com',
  'signup.password': 'Furaha sirta',
  'signup.passwordPlaceholder': 'Ugu yaraan 6 xaraf',
  'signup.step2': 'Noo sheeg dukaankaaga',
  'signup.shopName': 'Magaca dukaanka',
  'signup.shopNamePlaceholder': 'Magaca dukaankaaga',
  'signup.step3': 'Halkee buu dukaankaagu yaal?',
  'signup.city': 'Magaalada',
  'signup.cityPlaceholder': 'Hargeysa',
  'signup.neighborhood': 'Xaafadda ama calaamad',
  'signup.neighborhoodPlaceholder': 'tusaale Jigjiga Yar, agagaarka suuqa weyn',
  'signup.create': 'Samee akoon',
  'signup.creating': 'Waa la samaynayaa…',
  'signup.error': 'Wax baa qaldamay. Fadlan mar kale isku day.',
  'signup.haveShop': 'Horey ma u leedahay dukaan? Gal',
  'signup.termsBefore':
    'Adigoo sii wata, waxaad ogolaanaysaa inaad si xushmad leh u isticmaasho Kaiibi, xogtaadana sax u hayso, oo aad aqbasho',
  'signup.privacy': 'Siyaasadda Asturnaanta',

  // ── shared ────────────────────────────────────────────────────────────────
  'common.back': 'Dib u noqo',
  'common.continue': 'Sii wad',
};
