# 3. A new model must beat the champion on the same unseen days

**Decision.** A retrain only creates a *challenger*. It is promoted only if its Brier score is lower than the champion's on the same test days. Those days all come after the champion's last training day, so neither model has seen them. With no champion yet, it has to beat the "every bus runs at the average rate" baseline. Rejected models stay in the registry with the reason.

**Why.**
- Retraining doesn't always help. A bad week of data, a bug in a feature, or plain noise can make a model worse.
- Comparing the two models on days the champion was trained on would favour the champion. Comparing them on different days wouldn't be fair either.
- The gate needs at least 2 test days and 10 ghost buses. With fewer, it keeps the champion rather than decide on noise.

**Trade-off.** A real improvement can wait a few days until there are enough unseen days to prove it.
