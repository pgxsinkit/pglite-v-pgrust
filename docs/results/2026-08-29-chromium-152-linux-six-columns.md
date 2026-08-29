# pglite-v-pgrust benchmark run

- Browser: chromium
- Started: 2026-08-29T03:55:45.372Z
- Driver: bun run bench

@pgxsinkit/pglite 0.5.5-pgx.2 | pgrust dab0f92940 | wa-sqlite v1.1.2 (github) | JSPI available | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36

### Speedtest Suite

@pgxsinkit/pglite 0.5.5-pgx.2 | pgrust dab0f92940 | wa-sqlite v1.1.2 (github) | JSPI available | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36

| Benchmark | PGlite Memory (ms) | PGlite Memory (unlogged) (ms) | vs PGlite Memory | pgrust Memory (ms) | vs PGlite Memory | pgrust Memory (unlogged) (ms) | vs PGlite Memory | wa-sqlite Memory (ms) | vs PGlite Memory | wa-sqlite Memory (journal off) (ms) | vs PGlite Memory |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Test 1: 1000 INSERTs | 55.500 | 56.900 | 1.03× | 357.800 | 6.45× | 350.400 | 6.31× | 109.800 | 1.98× | 54.300 | 0.98× |
| Test 2: 25000 INSERTs in a transaction | 558.400 | 538.900 | 0.97× | 5077.500 | 9.09× | 4944.500 | 8.85× | 136.200 | 0.24× | 133.400 | 0.24× |
| Test 2.1: 25000 INSERTs in single statement | 140.900 | 124.800 | 0.89× | 211.000 | 1.50× | 177.300 | 1.26× | 38.500 | 0.27× | 39.000 | 0.28× |
| Test 3: 25000 INSERTs into an indexed table | 735.300 | 678.500 | 0.92× | 4915.500 | 6.69× | 4726.200 | 6.43× | 181.500 | 0.25× | 181.100 | 0.25× |
| Test 3.1: 25000 INSERTs into an indexed table in single statement | 164.800 | 146.900 | 0.89× | 223.700 | 1.36× | 198.800 | 1.21× | 60.400 | 0.37× | 61.400 | 0.37× |
| Test 4: 100 SELECTs without an index | 312.900 | 346.900 | 1.11× | 394.100 | 1.26× | 383.600 | 1.23× | 195.600 | 0.63× | 192.200 | 0.61× |
| Test 5: 100 SELECTs on a string comparison | 797.200 | 796.400 | 1.00× | 712.200 | 0.89× | 672.000 | 0.84× | 820.500 | 1.03× | 794.200 | 1.00× |
| Test 6: Creating an index | 28.300 | 27.300 | 0.96× | 33.500 | 1.18× | 32.500 | 1.15× | 24.700 | 0.87× | 24.900 | 0.88× |
| Test 7: 5000 SELECTs with an index | 483.600 | 458.100 | 0.95× | 1111.000 | 2.30× | 1121.100 | 2.32× | 83.600 | 0.17× | 75.600 | 0.16× |
| Test 8: 1000 UPDATEs without an index | 156.800 | 159.200 | 1.02× | 243.400 | 1.55× | 246.000 | 1.57× | 60.400 | 0.39× | 62.400 | 0.40× |
| Test 9: 25000 UPDATEs with an index | 1342.600 | 1281.500 | 0.95× | 5026.400 | 3.74× | 4793.400 | 3.57× | 265.600 | 0.20× | 251.800 | 0.19× |
| Test 10: 25000 text UPDATEs with an index | 1692.400 | 1545.800 | 0.91× | 6351.500 | 3.75× | 6266.300 | 3.70× | 209.300 | 0.12× | 202.600 | 0.12× |
| Test 11: INSERTs from a SELECT | 275.600 | 167.600 | 0.61× | 309.100 | 1.12× | 209.300 | 0.76× | 84.200 | 0.31× | 79.700 | 0.29× |
| Test 12: DELETE without an index | 26.400 | 19.500 | 0.74× | 46.700 | 1.77× | 29.000 | 1.10× | 44.000 | 1.67× | 33.800 | 1.28× |
| Test 13: DELETE with an index | 30.200 | 20.100 | 0.67× | 65.700 | 2.18× | 41.400 | 1.37× | 62.800 | 2.08× | 61.700 | 2.04× |
| Test 14: A big INSERT after a big DELETE | 160.700 | 134.400 | 0.84× | 243.400 | 1.51× | 201.300 | 1.25× | 64.100 | 0.40× | 63.800 | 0.40× |
| Test 15: A big DELETE followed by many small INSERTs | 240.800 | 226.300 | 0.94× | 1350.900 | 5.61× | 1277.200 | 5.30× | 57.000 | 0.24× | 53.500 | 0.22× |
| Test 16: DROP TABLE | 4.700 | 4.600 | 0.98× | 8.900 | 1.89× | 10.000 | 2.13× | 6.900 | 1.47× | 6.700 | 1.43× |

### RTT Suite

@pgxsinkit/pglite 0.5.5-pgx.2 | pgrust dab0f92940 | wa-sqlite v1.1.2 (github) | JSPI available | Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/149.0.7827.55 Safari/537.36

| Benchmark | PGlite Memory (ms) | PGlite Memory (unlogged) (ms) | vs PGlite Memory | pgrust Memory (ms) | vs PGlite Memory | pgrust Memory (unlogged) (ms) | vs PGlite Memory | wa-sqlite Memory (ms) | vs PGlite Memory | wa-sqlite Memory (journal off) (ms) | vs PGlite Memory |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Test 1: insert small row | 0.376 | 0.324 | 0.86× | 0.434 | 1.15× | 0.379 | 1.01× | 0.135 | 0.36× | 0.082 | 0.22× |
| Test 2: select small row | 0.440 | 0.271 | 0.62× | 0.284 | 0.64× | 0.331 | 0.75× | 0.046 | 0.11× | 0.073 | 0.16× |
| Test 3: update small row | 0.248 | 0.244 | 0.98× | 0.386 | 1.56× | 0.417 | 1.69× | 0.045 | 0.18× | 0.075 | 0.30× |
| Test 4: delete small row | 0.419 | 0.390 | 0.93× | 1.126 | 2.69× | 0.933 | 2.23× | 0.200 | 0.48× | 0.135 | 0.32× |
| Test 5: insert 1kb row | 0.253 | 0.266 | 1.05× | 0.371 | 1.47× | 0.329 | 1.30× | 0.155 | 0.61× | 0.087 | 0.35× |
| Test 6: select 1kb row | 0.402 | 0.427 | 1.06× | 0.899 | 2.23× | 0.892 | 2.22× | 0.089 | 0.22× | 0.074 | 0.18× |
| Test 7: update 1kb row | 0.268 | 0.273 | 1.02× | 0.411 | 1.54× | 0.414 | 1.55× | 0.052 | 0.20× | 0.052 | 0.20× |
| Test 8: delete 1kb row | 0.376 | 0.379 | 1.01× | 0.904 | 2.40× | 0.871 | 2.32× | 0.146 | 0.39× | 0.079 | 0.21× |
| Test 9: insert 10kb row | 0.374 | 0.371 | 0.99× | 0.629 | 1.68× | 0.552 | 1.48× | 0.203 | 0.54× | 0.143 | 0.38× |
| Test 10: select 10kb row | 0.520 | 0.415 | 0.80× | 0.611 | 1.18× | 0.632 | 1.22× | 0.101 | 0.19× | 0.105 | 0.20× |
| Test 11: update 10kb row | 0.346 | 0.350 | 1.01× | 0.344 | 0.99× | 0.347 | 1.00× | 0.095 | 0.27× | 0.085 | 0.25× |
| Test 12: delete 10kb row | 0.382 | 0.440 | 1.15× | 0.706 | 1.85× | 0.649 | 1.70× | 0.148 | 0.39× | 0.080 | 0.21× |
