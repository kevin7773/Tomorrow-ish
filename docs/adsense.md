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
3. Recheck the Privacy Policy against the final ad and analytics configuration.
4. In AdSense **Privacy & messaging**, publish Google's certified European regulations
   message for EEA, UK, and Swiss traffic before serving personalized ads there. Google's
   own consent-management solution participates in the IAB TCF and satisfies Google's CMP
   certification requirement; a custom site CMP is not needed for the current architecture.
5. Review legal applicability for US state privacy laws, then configure AdSense's US state
   regulations message, geographic targeting, and opt-out choices for all applicable states.
   Google's Privacy & messaging tool can carry the resulting consent/opt-out signals; no
   speculative consent script is added to the site while advertising remains disabled.
6. Confirm Auto Ads remain disabled in AdSense unless separately reviewed.
7. Re-run the public/editorial boundary tests and inspect representative short and
   long stories for layout stability.

The Google-managed messages are configured and published in the AdSense account. Once
the governed AdSense loader is deliberately enabled, Google serves those messages from
the top-level page. Site code remains responsible for keeping the correct publisher tag,
providing durable Privacy and Contact links, and avoiding any competing custom consent
implementation. Legal obligations and geographic targeting still require publisher review.
