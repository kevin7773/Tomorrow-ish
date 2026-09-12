# Governed AdSense setup

Tomorrow-ish verifies AdSense ownership with the public account meta tag for
`ca-pub-4913684525326701` and the authorized-seller record at `/ads.txt`. Neither
mechanism requests or renders an ad.

Ad delivery is fail-closed. `ADS_ENABLED` must equal `true`, and a placement must
also have a numeric AdSense slot ID before the public layout loads the HTTPS
AdSense script or the reusable `AdSlot` component emits slot markup. Editorial
routes use a separate layout and never load AdSense infrastructure.

The prepared production variables are:

- `ADS_ENABLED` — global delivery gate; keep `false` until launch review is complete.
- `ADSENSE_ARTICLE_INLINE_1_SLOT` — first article-body unit.
- `ADSENSE_ARTICLE_INLINE_2_SLOT` — second unit for sufficiently long articles.
- `ADSENSE_DESKTOP_SIDEBAR_SLOT` — reserved for a future layout that naturally supports it.

Only article inline hooks are currently mounted. Articles with fewer than four
paragraphs receive no placements, articles with four or five receive at most one
after paragraph two, and articles with six or more receive at most two after
paragraphs two and five. No slot appears above the headline, between the headline
and hero image, or in site navigation.

Before setting `ADS_ENABLED=true`:

1. Finish AdSense site review and create the desired responsive ad units.
2. Configure the issued numeric slot IDs in Wrangler.
3. Update the Privacy Policy before advertising is introduced.
4. Decide the intended geographic ad-serving scope and configure a Google-certified
   consent management platform where required, including EEA, UK, and Swiss traffic.
5. Confirm Auto Ads remain disabled in AdSense unless separately reviewed.
6. Re-run the public/editorial boundary tests and inspect representative short and
   long stories for layout stability.
