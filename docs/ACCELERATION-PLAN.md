# ₹1L Revenue Acceleration Plan
**FOFUS — July 21 → Aug 18, 2026 (28 days)**

## Current Reality
- 90-day revenue: ₹45,583
- Daily average: ₹506/day
- Goal: ₹1,00,000 by Aug 18, 2026
- Remaining: ₹54,417
- Required daily revenue: **₹1,943/day**
- Gap: **4x acceleration needed**

---

## Executive Decision Framework

| Priority | Initiative | Owner | Impact | Status |
|---|---|---|---|---|
| P0 | Fix revenue leak: quote→order conversion | Tech / CEO | High | In progress |
| P0 | Google Shopping feed optimized + ads on | Growth / Tech | High | Done feed, need ads |
| P1 | WhatsApp broadcast quote offers | Sales / CEO | High | Not started |
| P1 | Instagram viral push (NOT sell, build desire) | CMO | Medium | Active via cron |
| P1 | B2B/corporate gifting outreach | CEO | High | Not started |
| P2 | Shopify product bundles / upsells | CEO / Ops | Medium | Not started |
| P2 | Amazon/Flipkart marketplace connect | Ops | Low | Blocked |

---

## P0: fofus-quote Conversion Funnel (Now Live)

**URL:** https://quote.business.fofus.in

### Done
- [x] Frontend live on Railway backend
- [x] Instant in-browser STL quote
- [x] PDF quote download
- [x] Submit job to backend
- [x] OrcaSlicer backend re-slicing

### Needs Now
- [ ] Collect customer contact details before submit
- [ ] Store jobs in backend DB
- [ ] Forward accepted jobs to PrintDash automatically
- [ ] Notify CEO/ops via Telegram/WhatsApp on new quote request
- [ ] Follow-up email/SMS within 1 hour
- [ ] Add admin panel to view all pending quotes

### Target
If fofus-quote drives 5 requests/day at ₹500 avg = ₹2,500/day → **alone covers required ₹1,943/day**.

---

## P0: Google Shopping / Performance Max Ads

### Done
- [x] Feed optimized: 1038 products
- [x] Local inventory ads exclusion removed
- [x] display_ads exclusions tightened to ~173 true religious products
- [x] Feed deployed to https://fofus.in/google-shopping.xml

### Needs Now
- [ ] Link GMC + Google Ads account
- [ ] Create Performance Max campaign (India, all products except excluded)
- [ ] Set daily budget ₹500–1000
- [ ] Add negative keywords for non-buyers
- [ ] Conversion tracking via Shopify/Google Ads tag

### Target
With ₹500/day ad spend and 2-3% CTR, aim for 50-100 clicks/day. At 2% conversion and ₹2,000 AOV = ₹2,000–4,000/day revenue.

---

## P1: WhatsApp Broadcast Sales

- Use WhatsApp Broadcast Lists (manual from phone only — no bulk API)
- Target: existing customers, warm leads, saved contacts
- Offer: "Upload your STL at quote.fofus.in / fofus.in and get instant 3D print quote"
- Frequency: max 1/day
- Do NOT hard-sell. Share quote link + example prints.

---

## P1: B2B / Corporate Gifting

- Target: architects, product designers, schools, event managers, corporates in Kerala
- Offer: bulk custom 3D printed gifts, trophies, prototypes
- Outreach: 20 cold messages/day via LinkedIn/WhatsApp
- Goal: 1 bulk order of ₹10,000+ per week

---

## P1: Instagram Content Push (No Selling)

Per COMPANY LAW: no hard sell. Build desire.
- Behind-the-scenes prints
- Time-lapse videos
- Customer unboxing
- Religious idol timelapses (high engagement)
- Target: Reels, 1 post/day, drive profile clicks to link in bio

---

## Metrics to Track Daily

| Metric | Current | Target |
|---|---|---|
| Shopify daily revenue | ₹506 | ₹1,943 |
| fofus-quote requests/day | 0 | 5+ |
| fofus-quote conversion to paid | — | 40% |
| Google Shopping clicks/day | — | 50+ |
| Ad spend/day | ₹0 | ₹500–1000 |
| Instagram followers | 872 | 1200 |
| WhatsApp broadcasts/day | — | 1 |

---

## Daily Execution Ritual

1. **09:00** — Check previous day revenue, fofus-quote requests, printer status
2. **10:00** — 1 WhatsApp broadcast / Instagram post
3. **11:00** — Follow up pending fofus-quote requests
4. **14:00** — B2B outreach (10 messages)
5. **17:00** — Review Google Shopping / ad performance
6. **20:00** — Second B2B outreach block (10 messages)

---

## Decision Log

| Date | Decision | Owner |
|---|---|---|
| 2026-07-21 | Pause Local Inventory Ads (physical shop not focus) | Exec team |
| 2026-07-21 | Remove polluted tag-based identity exclusions | Exec team |
| 2026-07-21 | Keep 173 true religious products excluded from display_ads | Exec team |
| 2026-07-21 | Launch fofus-quote as primary customer acquisition channel | Exec team |
| 2026-07-21 | Approve ₹500–1000/day Performance Max budget | Pending owner |

---

## Immediate Next Actions

1. [ ] Approve ad budget — owner
2. [ ] Provide Google Ads account access — owner
3. [ ] Confirm WhatsApp broadcast strategy — CEO
4. [ ] Fix PrintDash systemd services — manual (needs sudo)
5. [ ] Add customer contact form to fofus-quote — tech
6. [ ] Wire fofus-quote notifications to Telegram — tech
7. [ ] Set up Performance Max campaign — growth

**System builder note:** Technical pieces 5-6 can be done now without owner input. Ad budget and account access need owner/CEO.
