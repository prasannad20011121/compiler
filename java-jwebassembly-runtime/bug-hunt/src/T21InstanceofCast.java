import de.inetsoftware.jwebassembly.api.annotation.Export;

public class T21InstanceofCast {
    static class Animal {}
    static class Dog extends Animal { int bark() { return 42; } }
    static class Cat extends Animal { int meow() { return 7; } }

    @Export
    public static int run(int wantDog) {
        Animal a = wantDog != 0 ? new Dog() : new Cat();
        if (a instanceof Dog) {
            return ((Dog) a).bark();
        } else if (a instanceof Cat) {
            return ((Cat) a).meow();
        }
        return -1;
    }
}
