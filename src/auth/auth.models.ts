export class InitData {
    authDateRaw: number;
    hash: string;
    user: User;

    constructor(data: any) {
        this.authDateRaw = Number(data.auth_date);
        this.hash = data.hash;
        this.user = new User(JSON.parse(data.user));
    }

    get authDate(): Date {
        return new Date(this.authDateRaw * 1000);
    }
}

export class User {
    id: string;
    firstName: string;
    lastName?: string;
    username?: string;
    language_code: string;
    photo_url: string;
    is_premium: boolean;

    constructor(data: any) {
        this.id = data.id.toString();
        this.firstName = data.first_name;
        this.lastName = data.last_name;
        this.username = data.username;
        this.language_code = data.language_code;
        this.photo_url = data.photo_url;
        this.is_premium = data.is_premium;
    }
}