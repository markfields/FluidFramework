/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

module.exports = {
    "extends": [
        "@fluidframework/eslint-config-fluid"
    ],
    "rules": {
        "import/no-internal-modules": [ "error", {
          "allow": [ "dataObjects/*" ]
        } ]
      }
}