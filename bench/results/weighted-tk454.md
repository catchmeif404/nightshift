# TK-454 pilot recomputed with price weights

Weights (ratio to uncached input): {"input":1,"output":5,"cache_write":1.25,"cache_read":0.1}. Same 6 runs, no new runs. Exploratory, 1 run per cell: not a claim of any saving.

| task | arm | raw total tokens | price-weighted units |
|---|---|---|---|
| t1 | OFF | 176304 | 90608.1 |
| t1 | ON | 216444 | 96256.1 |
| t2 | OFF | 218062 | 101406.1 |
| t2 | ON | 291826 | 108264.4 |
| t3 | OFF | 251784 | 108193.0 |
| t3 | ON | 294414 | 118552.8 |

| task | ON/OFF raw total | ON/OFF price-weighted |
|---|---|---|
| t1 | 1.228 | 1.062 |
| t2 | 1.338 | 1.068 |
| t3 | 1.169 | 1.096 |
| median | 1.228 | 1.068 |
