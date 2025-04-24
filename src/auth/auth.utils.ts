import { ParsedUrlQuery, parse as parseQueryString } from 'querystring';
import { createHmac } from 'crypto';
import { ExpiredError, UnexpectedFormatError, SignMissingError, SignInvalidError } from '../constants/auth.constants';
import { InitData } from './auth.models';

export function validate(initData: string, token: string, expIn: number): void {
    let parsedData: ParsedUrlQuery;

    try {
        parsedData = parseQueryString(initData);
    } catch {
        throw new UnexpectedFormatError();
    }

    const hashValue = parsedData['hash'];
    const authDate = parsedData['auth_date']
        ? new Date(Number(parsedData['auth_date']) * 1000)
        : null;

    if (!hashValue) {
        throw new SignMissingError();
    }

    if (expIn > 0 && authDate) {
        const expiryDate = new Date(authDate);
        expiryDate.setSeconds(expiryDate.getSeconds() + expIn);
        if (expiryDate < new Date()) {
            throw new ExpiredError();
        }
    }

    const pairs = Object.entries(parsedData)
        .filter(([key]) => key !== 'hash')
        .map(([key, value]) => `${key}=${value}`)
        .sort()
        .join('\n');

    const calculatedHash = sign(pairs, token);

    if (calculatedHash !== hashValue) {
        throw new SignInvalidError();
    }
}

export function sign(payload: string, key: string): string {
    const skHmac = createHmac('sha256', 'WebAppData').update(key).digest();
    return createHmac('sha256', skHmac).update(payload).digest('hex');
}

export function parse(initData: string): InitData {
    let parsedData: ParsedUrlQuery;

    try {
        parsedData = parseQueryString(initData);
    } catch {
        throw new UnexpectedFormatError();
    }

    const jsonData = Object.fromEntries(
        Object.entries(parsedData).map(([key, value]) => [key, value])
    );

    try {
        return new InitData(jsonData);
    } catch {
        throw new UnexpectedFormatError();
    }
}