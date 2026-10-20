import time
def adder(x):
    return lambda y: x + y
t = time.perf_counter()
total = 0
for i in range(1_000_000):
    add = adder(i)
    total = add(total) % 1000
print(time.perf_counter() - t)
