## as_recorded (34 runs)

| task | arm | n | outcomes | core | detail | weighted cost mean | CV | wall s (median) | interventions (mean) | rework (mean) |
|---|---|---|---|---|---|---|---|---|---|---|
| A | A2 | 4 | {"finished":4} | 8/8 | 20/20 | 213733 (n=4) | 0.07 | 192 | 0.00 | 0.00 |
| A | B0 | 8 | {"stalled":1,"error":3,"finished":4} | 8/16 | 16/40 | 156124 (n=5) | 0.30 | 93 | 0.50 | n/a |
| A | B2 | 6 | {"stalled":2,"finished":4} | 8/12 | 20/30 | 123141 (n=6) | 0.36 | 133 | 0.50 | n/a |
| B | A2 | 4 | {"finished":4} | 16/16 | 32/36 | 445815 (n=4) | 0.09 | 668 | 0.00 | 0.00 |
| B | B0 | 5 | {"finished":4,"error":1} | 17/20 | 21/45 | 178856 (n=4) | 0.10 | 217 | 0.00 | n/a |
| B | B2 | 7 | {"stalled":1,"finished":4,"error":2} | 19/28 | 37/63 | 389247 (n=5) | 0.50 | 407 | 0.14 | n/a |

Phase-2 plan input: {"cost_cv_median":0.19793895054323435,"cost_cv_max":0.5048071868402049,"n_per_arm_cost":{"diff_10pct":{"by_median_cv":62,"by_max_cv":401},"diff_20pct":{"by_median_cv":16,"by_max_cv":101}},"n_per_arm_pass":{"diff_20pt":63,"diff_30pt":26},"mean_core_rate":0.7825396825396825,"mean_detail_rate":0.6682539682539682,"n_per_arm_pass_detail":{"diff_20pt":84,"diff_30pt":35}}

## harness_defects_replaced (24 runs)

| task | arm | n | outcomes | core | detail | weighted cost mean | CV | wall s (median) | interventions (mean) | rework (mean) |
|---|---|---|---|---|---|---|---|---|---|---|
| A | A2 | 4 | {"finished":4} | 8/8 | 20/20 | 213733 (n=4) | 0.07 | 192 | 0.00 | 0.00 |
| A | B0 | 4 | {"finished":4} | 8/8 | 16/20 | 171214 (n=4) | 0.22 | 92 | 1.00 | n/a |
| A | B2 | 4 | {"finished":4} | 8/8 | 20/20 | 149471 (n=4) | 0.16 | 126 | 0.75 | n/a |
| B | A2 | 4 | {"finished":4} | 16/16 | 32/36 | 445815 (n=4) | 0.09 | 668 | 0.00 | 0.00 |
| B | B0 | 4 | {"finished":4} | 16/16 | 20/36 | 178856 (n=4) | 0.10 | 262 | 0.00 | n/a |
| B | B2 | 4 | {"finished":4} | 16/16 | 34/36 | 468535 (n=4) | 0.21 | 544 | 0.25 | n/a |

Phase-2 plan input: {"cost_cv_median":0.127359710724209,"cost_cv_max":0.21908715901704937,"n_per_arm_cost":{"diff_10pct":{"by_median_cv":26,"by_max_cv":76},"diff_20pct":{"by_median_cv":7,"by_max_cv":19}},"n_per_arm_pass":{"diff_20pt":135,"diff_30pt":69},"mean_core_rate":1,"mean_detail_rate":0.8648148148148148,"n_per_arm_pass_detail":{"diff_20pt":42,"diff_30pt":25}}

