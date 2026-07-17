import { formatMoney } from "react-toolkitz";
import _ from "lodash";
import { helper } from "./utils.js";

export function main() {
  console.log(_.capitalize(helper()), formatMoney(42));
}

main();
