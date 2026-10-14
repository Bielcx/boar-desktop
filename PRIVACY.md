# BOAR Privacy Policy

> **Preview: first draft, under review.** This policy describes what BOAR does today, as accurately
> as we can, but it hasn't had a legal review yet and may change. We publish it now so you can see
> what the app does with data before it is final. Questions or corrections: privacy@boarapp.com or
> an issue at [github.com/rferrari/boar-app](https://github.com/rferrari/boar-app/issues).

Version 0.9 (preview) · 30 September 2026 · Contact: privacy@boarapp.com

BOAR is an offline AI research app for Android and iOS, and boarapp.com is its website. BOAR is a
free, open-source project built by its community of contributors ("we", "us"). There is no company
behind it. The project's maintainers run the sharing service and handle the personal data described
here (the "controller" under the GDPR and Brazil's LGPD); you reach them at privacy@boarapp.com.

This policy covers the BOAR app (both the standard build and the offline build) and boarapp.com. It
is written with the EU and UK GDPR, Brazil's LGPD, California's CCPA/CPRA and similar laws in mind,
and applies to everyone, wherever they live. A Portuguese version is at
[docs/legal/PRIVACY.pt.md](docs/legal/PRIVACY.pt.md); if the two differ, this English version
prevails, except where your local law requires otherwise.

## In short

- **Your questions, answers, conversations and documents never leave your phone.** BOAR answers
  with a model that runs on the phone. There is no account, no advertising, and no analytics or
  crash reporting in the app.
- **The app uses the internet only when you ask it to:** to download models and packs, to search
  Hugging Face for a model, and to share an evaluation run. The offline build has no internet
  permission at all.
- **Sharing a run is optional.** You see everything that will be sent before you confirm. What becomes
  public is a phone's model and chip with its scores, never anything that identifies you.
- **Your phone is yours to protect.** BOAR keeps your data on your phone and doesn't encrypt it beyond
  what the phone does for every app (section 9).

## 1. What stays on your phone

These are processed only on your device and are never sent to us or anyone else by BOAR:

- your questions and BOAR's answers, conversations and their summaries;
- documents you import and the collections made from them;
- the knowledge base and the searches over it;
- your location: read only when you ask about places near you, used on the phone, and never sent
  anywhere by BOAR, which has no geocoder. On Android it comes from the phone's GPS alone, with no
  network location service. On iPhone it comes from iOS's Core Location, which may also use Wi-Fi and
  cell signals through Apple's location service, under Apple's privacy policy;
- BOAR's performance log (model, speed, memory for each answer), which never includes your
  questions or answers, and leaves the phone only if you export it yourself;
- evaluation runs (BOAR's fixed test questions and the model's answers to them), until you share
  or export one;
- your settings, and a security key that BOAR creates in the phone's secure hardware for sharing.

**Deleting it:** Settings → Erase all data deletes your conversations, documents, models,
knowledge packs and settings. Two things stay until you uninstall the app: saved evaluation runs and
the sharing key. Uninstalling BOAR deletes everything it stored on the phone.

## 2. When the app uses the internet

The standard build connects to the internet only in these cases, each started by you. Nothing is sent
in the background.

### 2.1 Downloading models, knowledge packs and places

When you set up BOAR or tap Download, the phone fetches the file from **Hugging Face**
(huggingface.co) or **GitHub** (github.com, raw.githubusercontent.com). BOAR sends only the request
for the file. Like any website, those services see your IP address, the time and the file requested,
under their own privacy policies ([Hugging Face](https://huggingface.co/privacy),
[GitHub](https://docs.github.com/site-policy/privacy-policies/github-general-privacy-statement)).
We don't receive any of it.

### 2.2 Searching Hugging Face for a model

If you use "Search Hugging Face", BOAR sends your search words to Hugging Face's public API, only when
you search. Hugging Face's privacy policy applies.

### 2.3 Sharing an evaluation run (optional)

The Evaluation screen can run BOAR's fixed set of test questions and, if you choose **Share results**,
send the run to us so anyone can compare how models perform on different phones. Sharing is available
on Android; on iOS it isn't open yet. Before anything is sent, the app shows you every field. We
receive:

- **about the phone:** platform, OS version and API level, brand and model, chipset and its maker,
  board name, total RAM, CPU core count, CPU features and core speeds;
- **about the run:** its id, the app and test-set versions, and for each test question the model
  used, the answer the model wrote to *our* fixed question, the sources it found, timings, memory and
  whether it finished;
- **a security key made for BOAR in the phone's secure hardware.** Its public part, and on the first
  share its certificate from the phone maker, prove that the run comes from a real phone running the
  official app. The certificate also shows the phone's security update level and whether its
  bootloader is locked. The key is not linked to you, your accounts or your phone number;
- **a keyed hash of your IP address** (SHA-256 with a secret only the server knows), used only to
  limit how many runs one network can send. We don't store the IP address itself.

We never receive your own questions, conversations, documents, name, contacts or location.

**What is public:** the phone's brand and model, chipset, RAM, core information, the app and test
versions, and each model's scores and speeds. This appears on the public results, readable by anyone.
The key, the IP hash, the answers and the certificate details are never public.

**Review:** some genuine phones can't prove their key comes from secure hardware. Their runs are stored
but kept hidden until the BOAR team reviews them.

### 2.4 Voice input

Voice input is off until you turn it on. On iPhone and on Android 12 or later, speech is recognized
on the phone. On some older Android phones, voice uses the phone's own speech service, which may send
the audio to its provider (often Google). BOAR warns you and asks first. That provider's privacy
policy applies, and we never receive the audio or the text.

### 2.5 Opening a place in a maps app

If you tap "Open in maps" on a place, BOAR hands that place's coordinates to the maps app you choose.
That app's privacy policy applies from then on.

### 2.6 The offline build

BOAR's offline build has no internet permission. None of section 2 applies to it: models and packs are
imported from files, and nothing can be shared.

## 3. The website (boarapp.com)

- **Hosting:** boarapp.com is hosted by Vercel, which logs requests (IP address, time, page) to run
  and protect the site ([Vercel privacy policy](https://vercel.com/legal/privacy-policy)).
- **Analytics:** the site uses Google Analytics 4 to count visits and see which pages are read. It
  collects your approximate location, device, browser and the pages you visit, and sets cookies;
  Google Analytics 4 doesn't store IP addresses. We are adding a consent banner so it only loads if
  you accept. Until then, you can block it with
  [Google's opt-out add-on](https://tools.google.com/dlpage/gaoptout) or any content blocker. See
  [how Google uses data](https://policies.google.com/technologies/partner-sites).

## 4. Why we process it (legal bases)

| What | Why | Legal basis (GDPR / LGPD) |
|---|---|---|
| A shared run and its phone details | To publish comparable results, because you asked us to | Consent (art. 6(1)(a) GDPR; art. 7, I LGPD) |
| The security key, certificate and IP hash | To stop fake, scripted or repeated runs | Legitimate interest in keeping the results honest (art. 6(1)(f) GDPR; art. 7, IX LGPD) |
| Website analytics | To see how the site is used | Legitimate interest today; consent once the banner is in place |
| Website request logs | To run and secure the site | Legitimate interest |

You can withdraw consent at any time. It doesn't affect what was done before, and for a shared run,
withdrawing means asking us to delete it (section 7).

We don't sell your personal data, share it for targeted advertising, or use it to make automated
decisions about you.

## 5. Who processes it

- **Supabase** stores shared runs, on Amazon Web Services in the United States (us-west-2), under
  Supabase's data processing terms.
- **Vercel** hosts the website. **Google** provides the website's analytics.
- **Hugging Face** and **GitHub** serve the downloads (section 2.1), as independent services.

Some of these are in the United States. Where the law requires, transfers are covered by the providers'
Standard Contractual Clauses or equivalent safeguards (GDPR art. 46; LGPD art. 33).

## 6. How long we keep it

| Data | Kept for |
|---|---|
| One-time sharing codes | Deleted after 1 hour |
| Shared runs, their answers, the phone details, the key and the IP hash | For as long as the public results exist, or until you ask us to delete them |
| Website analytics | Google Analytics' retention setting (2 months) |

Stored runs can't be changed after they're stored. Only we can delete them, and we do on request. We
plan to erase IP hashes after 7 days, since the limits only look back 24 hours; until then they're
kept with the run.

## 7. Your rights

Wherever you live, you can ask us to:

- tell you what we hold about you, and give you a copy (access, portability);
- correct it, or delete it (erasure);
- stop or restrict using it, or object to how we use it;
- withdraw your consent.

**How to ask:** email privacy@boarapp.com. BOAR has no accounts, so we can only find a shared run by
its details. Include the run's id (the Evaluation screen shows it after a run, in the "Saved to" line:
`eval-<date and time>`), your phone's model, and roughly when you shared it. We answer within 30 days
(15 days in Brazil; 45 days under the CCPA), and never charge for it.

**Depending on where you live:**

- **EU, EEA and UK:** you may also complain to your data protection authority.
- **Brazil (LGPD, art. 18):** you have the rights above, plus confirmation that we process your data,
  anonymization of unneeded data, information about who we share it with, and a review of consent. You
  may complain to the ANPD (Autoridade Nacional de Proteção de Dados).
- **California (CCPA/CPRA) and other US states with privacy laws:** you have the right to know,
  delete, correct, and to opt out of sale or sharing. We don't sell or share personal information, and
  we won't treat you differently for using your rights.

## 8. Children

BOAR is not directed to children under 13, or under 16 where local law sets that age for consent (for
example in parts of the EU). We don't knowingly collect their personal data. If you believe a child
has shared a run, contact us and we'll delete it.

## 9. Security, and what is up to you

**On the server:** shared runs are signed with the phone's hardware key and sent over HTTPS. The
server checks each signature and one-time code, and stored runs can't be changed or deleted except by
us. The database is private except for the public scores, and it holds nothing that names you. If a
breach puts your data at risk, we'll notify the authorities and affected people as the law requires.

**On your phone:** everything in section 1 lives on your phone, under your control. BOAR doesn't
encrypt it beyond what the phone's operating system does for every app. On Android, BOAR's data is
excluded from cloud backup and device transfer; on iOS, the app's documents folder is visible in the
Files app and may be included in your iCloud backup. Anyone who can unlock or take over your phone,
or read its backups, can read what BOAR stored. Keeping your phone, its lock screen, its backups and
anything you export safe is up to you.

**Open source:** BOAR's code is public. That lets anyone check what it does, and also means anyone can
look for weaknesses in it. Like all software, it may have security flaws we don't know about, and the
services it relies on can be attacked or fail. No system is perfectly secure, and we can't promise
that ours won't be breached. Only install BOAR from its official release page or a source you trust:
a modified copy isn't ours and isn't covered by this policy.

## 10. Changes

When this policy changes, we update the version and date above and describe the change in the
repository's history. For significant changes, the app or website will tell you before they apply.

## 11. Contact

Privacy requests and questions: **privacy@boarapp.com**.
The source code, including every place the app uses the network, is public at
[github.com/rferrari/boar-app](https://github.com/rferrari/boar-app).
