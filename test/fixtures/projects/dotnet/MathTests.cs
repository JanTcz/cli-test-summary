using Xunit;

public class MathTests
{
    [Fact]
    public void Adds() => Assert.Equal(2, 1 + 1);

    [Fact]
    public void Subtracts() => Assert.Equal(1, 3 - 1);

    [Fact(Skip = "not yet")]
    public void Divides() { }
}
