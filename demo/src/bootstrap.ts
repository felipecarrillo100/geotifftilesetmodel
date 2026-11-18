// The LuciadRIA license must be set before any RIA module that needs it is evaluated, so the app is loaded
// dynamically after it. The license file is not part of the repository: see demo/README.md.
import {setLicenseText} from "@luciad/ria/util/License.js";

const response = await fetch("./license.txt");
const text = response.ok ? await response.text() : "";
if (!text || text.trimStart().startsWith("<")) {
    document.getElementById("log")!.innerHTML =
        '<span class="error">No LuciadRIA license: copy your development license to demo/public/license.txt ' +
        "(see demo/README.md) and reload.</span>";
} else {
    setLicenseText(text);
    await import("./main.js");
}
