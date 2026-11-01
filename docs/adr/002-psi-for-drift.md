# 2. Detect data drift with PSI per feature

**Decision.** Every day, compare the last 7 judged days with the champion's training data, using the Population Stability Index (PSI) for each feature. Below 0.1 means stable. 0.1 to 0.2 means watch it. Above 0.2 means drift, which triggers a retrain.

**How.**
- Features with 30 or fewer distinct values (hour, weekday, route, operator, direction) are compared value by value.
- Continuous features use quantile bins from the training data. The end bins are open, so values outside the training range still count.
- The reference distribution is saved with each model version, so drift is always measured against what that model actually saw.

**Why not just retrain on a timer.** Timetable changes and new routes change the input data suddenly. PSI catches those within days, and the weekly retrain catches slow drift anyway. PSI is cheap, easy to explain, and has standard thresholds.

**Trade-off.** PSI only sees changes in the inputs. A change in how often buses actually run (concept drift) is caught by a different check: stored predictions are scored the next day, and a 25% worse Brier score also triggers a retrain.
