import time
t = time.perf_counter()
total = 0
i = 0
while i < 10_000_000:
    total += i
    i += 1
print(time.perf_counter() - t)
