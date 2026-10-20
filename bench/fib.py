import time
def fib(n):
    if n < 2:
        return n
    return fib(n - 1) + fib(n - 2)
t = time.perf_counter()
fib(30)
print(time.perf_counter() - t)
