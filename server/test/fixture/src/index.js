import { formatMoney } from "react-toolkitz";
import _ from "lodash";
import { internalUtil } from "@fixture/internal";
import { helper, renderTag } from "./utils.js";

export function main() {
  console.log(_.capitalize(helper()), formatMoney(42), internalUtil(), renderTag("x"));
}

main();
