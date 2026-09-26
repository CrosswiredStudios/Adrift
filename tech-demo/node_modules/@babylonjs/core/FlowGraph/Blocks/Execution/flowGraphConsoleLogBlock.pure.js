/** This file must only contain pure code and pure imports */
import { FlowGraphExecutionBlockWithOutSignal } from "../../flowGraphExecutionBlockWithOutSignal.js";
import { RichTypeAny, RichTypeString } from "../../flowGraphRichTypes.pure.js";
import { Logger } from "../../../Misc/logger.js";
import { RegisterClass } from "../../../Misc/typeStore.js";
/**
 * Block that logs a message to the console.
 */
export class FlowGraphConsoleLogBlock extends FlowGraphExecutionBlockWithOutSignal {
    /**
     * Creates a new console log block.
     * @param config optional configuration
     */
    constructor(config) {
        super(config);
        this.message = this.registerDataInput("message", RichTypeAny);
        this.logType = this.registerDataInput("logType", RichTypeString, "log");
        if (typeof config?.messageTemplate === "string") {
            const matches = this._getTemplateMatches(config.messageTemplate);
            const registered = new Set();
            for (const match of matches) {
                if (!registered.has(match.name)) {
                    registered.add(match.name);
                    this.registerDataInput(match.name, RichTypeAny);
                }
            }
        }
    }
    /**
     * @internal
     */
    _execute(context) {
        const typeValue = this.logType.getValue(context);
        const messageValue = this._getMessageValue(context);
        if (typeValue === "warn") {
            Logger.Warn(messageValue);
        }
        else if (typeValue === "error") {
            Logger.Error(messageValue);
        }
        else {
            Logger.Log(messageValue);
        }
        // activate the output flow block
        this.out._activateSignal(context);
    }
    /**
     * @returns class name of the block.
     */
    getClassName() {
        return "FlowGraphConsoleLogBlock" /* FlowGraphBlockNames.ConsoleLog */;
    }
    _serializeValue(value) {
        if (value === null || value === undefined) {
            return String(value);
        }
        if (typeof value === "object") {
            // Prefer the object's own toString() (e.g. Vector3 → "{X:1 Y:2 Z:3}").
            // Only fall back to JSON.stringify when toString() is the unhelpful default.
            const str = value.toString();
            if (str === "[object Object]") {
                try {
                    return JSON.stringify(value);
                }
                catch {
                    return str;
                }
            }
            return str;
        }
        return String(value);
    }
    _getMessageValue(context) {
        if (typeof this.config?.messageTemplate === "string") {
            let template = this.config.messageTemplate;
            const matches = this._getTemplateMatches(template);
            // If the message input is an object, use its keys as the primary
            // source for template placeholders, falling back to named data inputs.
            const messageValue = this.message.getValue(context);
            const messageObj = messageValue !== null && messageValue !== undefined && typeof messageValue === "object" ? messageValue : null;
            const replacements = new Map();
            for (const match of matches) {
                if (replacements.has(match.name)) {
                    continue;
                }
                let value;
                if (messageObj !== null && match.name in messageObj) {
                    value = messageObj[match.name];
                }
                else {
                    value = this.getDataInput(match.name)?.getValue(context);
                }
                replacements.set(match.name, value === undefined ? undefined : this._serializeValue(value).replace(/[{}]/g, "$&$&"));
            }
            for (let index = matches.length - 1; index >= 0; index--) {
                const match = matches[index];
                const serialized = replacements.get(match.name);
                if (serialized !== undefined) {
                    template = template.substring(0, match.start) + serialized + template.substring(match.end + 1);
                }
            }
            return template.replace(/\{\{/g, "{").replace(/\}\}/g, "}");
        }
        else {
            // No template — pass the raw value directly so Logger receives the original
            // object (e.g. Vector3) rather than a stringified representation.
            return this.message.getValue(context);
        }
    }
    _getTemplateMatches(template) {
        let state = 0;
        let parameterStart = -1;
        const matches = [];
        for (let index = 0; index < template.length; index++) {
            const character = template[index];
            if (character === "{") {
                if (state === 0) {
                    state = 1;
                }
                else if (state === 1) {
                    state = 0;
                }
                else {
                    return [];
                }
            }
            else if (character === "}") {
                if (state === 0) {
                    state = 3;
                }
                else if (state === 3) {
                    state = 0;
                }
                else if (state === 2) {
                    matches.push({
                        name: template.substring(parameterStart + 1, index),
                        start: parameterStart,
                        end: index,
                    });
                    state = 0;
                }
                else {
                    return [];
                }
            }
            else if (state === 1) {
                parameterStart = index - 1;
                state = 2;
            }
            else if (state === 3) {
                return [];
            }
        }
        return state === 0 ? matches : [];
    }
}
let _Registered = false;
/**
 * Register side effects for flowGraphConsoleLogBlock.
 * Safe to call multiple times; only the first call has an effect.
 */
export function RegisterFlowGraphConsoleLogBlock() {
    if (_Registered) {
        return;
    }
    _Registered = true;
    RegisterClass("FlowGraphConsoleLogBlock" /* FlowGraphBlockNames.ConsoleLog */, FlowGraphConsoleLogBlock);
}
//# sourceMappingURL=flowGraphConsoleLogBlock.pure.js.map