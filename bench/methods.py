import time
class Counter:
    def __init__(self):
        self.n = 0
    def inc(self, by):
        self.n = self.n + by
t = time.perf_counter()
c = Counter()
for i in range(2_000_000):
    c.inc(i)
print(time.perf_counter() - t)
