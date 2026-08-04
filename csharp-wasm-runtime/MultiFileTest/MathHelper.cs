public static class MathHelper
{
    public static int Fibonacci(int n) => n <= 1 ? n : Fibonacci(n - 1) + Fibonacci(n - 2);

    public static long Factorial(int n) => n <= 1 ? 1 : n * Factorial(n - 1);

    public static bool IsPrime(int n)
    {
        if (n < 2) return false;
        for (int i = 2; i * i <= n; i++)
            if (n % i == 0) return false;
        return true;
    }

    public static List<int> Sieve(int limit)
    {
        var sieve = new bool[limit + 1];
        Array.Fill(sieve, true);
        sieve[0] = sieve[1] = false;
        for (int i = 2; i * i <= limit; i++)
            if (sieve[i])
                for (int j = i * i; j <= limit; j += i)
                    sieve[j] = false;
        return Enumerable.Range(2, limit - 1).Where(i => sieve[i]).ToList();
    }
}
