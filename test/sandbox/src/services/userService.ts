export class UserService {
    private users: string[] = ["a", "b"];

    findAll(): string[] {
        return this.users;
    }

    findOne(i: number): string {
        return this.users[i];   // BUG: keine Bereichspruefung
    }
}
