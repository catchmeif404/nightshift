| task | arm | outcome | completed | hidden tests | own tests | security | scope | rework rounds | total s | build s | rework s | review s | wait s | total tokens | out | cache read | cache write | input |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| t1 | OFF | pass | true | 9/9 | true | true | true | 0 | 44.68 | 22.35 | 0 | 19.03 | 3.31 | 176304 | 2538 | 121119 | 52637 | 10 |
| t1 | ON | pass | true | 9/9 | true | true | true | 0 | 48.99 | 24.07 | 0 | 19.44 | 5.48 | 216444 | 2539 | 159841 | 54052 | 12 |
| t2 | OFF | pass | true | 5/5 | true | true | true | 0 | 51.49 | 29.81 | 0 | 18.58 | 3.10 | 218062 | 3262 | 159479 | 55309 | 12 |
| t2 | ON | pass | true | 5/5 | true | true | true | 0 | 54.94 | 29.96 | 0 | 20.62 | 4.36 | 291826 | 3244 | 233634 | 54932 | 16 |
| t3 | OFF | pass | true | 11/11 | true | true | true | 0 | 52.34 | 29.19 | 0 | 19.71 | 3.44 | 251784 | 3556 | 191190 | 57024 | 14 |
| t3 | ON | pass | true | 11/11 | true | true | true | 0 | 63.98 | 33.13 | 0 | 23.80 | 7.04 | 294414 | 4334 | 231055 | 59009 | 16 |

| metric | t1 ON−OFF | t2 ON−OFF | t3 ON−OFF | t1 ratio | t2 ratio | t3 ratio | n pairs | median diff | median ratio |
|---|---|---|---|---|---|---|---|---|---|
| total_tokens | 40140 | 73764 | 42630 | 1.23 | 1.34 | 1.17 | 3 | 42630 | 1.23 |
| input_tokens | 2 | 4 | 2 | 1.20 | 1.33 | 1.14 | 3 | 2 | 1.20 |
| output_tokens | 1 | -18 | 778 | 1.00 | 0.99 | 1.22 | 3 | 1 | 1.00 |
| cache_read_tokens | 38722 | 74155 | 39865 | 1.32 | 1.46 | 1.21 | 3 | 39865 | 1.32 |
| cache_write_tokens | 1415 | -377 | 1985 | 1.03 | 0.99 | 1.03 | 3 | 1415 | 1.03 |
| total_s | 4.31 | 3.45 | 11.63 | 1.10 | 1.07 | 1.22 | 3 | 4.31 | 1.10 |
| build_s | 1.72 | 0.15 | 3.94 | 1.08 | 1.00 | 1.14 | 3 | 1.72 | 1.08 |
| rework_s | 0 | 0 | 0 | n/a | n/a | n/a | 3 | 0 | n/a |
| review_s | 0.41 | 2.04 | 4.09 | 1.02 | 1.11 | 1.21 | 3 | 2.04 | 1.11 |
| wait_overhead_s | 2.17 | 1.26 | 3.60 | 1.66 | 1.41 | 2.05 | 3 | 2.17 | 1.66 |
| rework_rounds | 0 | 0 | 0 | n/a | n/a | n/a | 3 | 0 | n/a |
| hidden_pass | 0 | 0 | 0 | 1 | 1 | 1 | 3 | 0 | 1 |
