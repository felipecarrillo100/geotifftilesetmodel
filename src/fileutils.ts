import type {HttpRequestHeaders} from "@luciad/ria/util/HttpRequestOptions";
import {parseWellKnownText} from "@luciad/ria/reference/ReferenceProvider";
import {HttpRequestParameters} from "@luciad/ria/util/HttpRequestOptions.js";

export async function getReferenceFromPrjFile(url: string, options: {
    credentials?: boolean;
    requestHeaders?: null | HttpRequestHeaders;
    requestParameters?: null | HttpRequestParameters;
}) {
    try {
        const prjPath = url.slice(0, url.lastIndexOf(".") + 1) + "prj";
        const prj = await getFileContent(prjPath, options);
        const reference = parseWellKnownText(prj);
        return reference.identifier;
    } catch (e) {
        return null;
    }
}

async function getFileContent(url: string, options:{ headers?: HttpRequestHeaders, credentials?: boolean}): Promise<string> {
    const x = await fetch(url, {
        headers: options.headers,
        credentials: options.credentials ? "same-origin" : "omit",
    });
    return await x.text();
}
