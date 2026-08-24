'use strict';

// The state a brand-new ledger starts from: StarLine's recurring expense list,
// no month history. Amounts marked `variable` are left for the admin to encode.

const GROUPS = ['Internet', 'Loans', 'Utilities', 'Payroll', 'Equipment', 'Fuel', 'Supplies', 'Other'];
const METHODS = ['GCash', 'BPI Credit Card', 'Bank Transfer', 'Cash', 'Auto-debit', 'Other'];

const CATS = [
  ['c01', 'Globe Fiber Biz Plus 1Gbps', '935267756', 'Internet', 'fixed', 9198, null, 'GCash', ''],
  ['c02', 'Globe Fiber Biz Plus 500Mbps', '939323320', 'Internet', 'fixed', 4200, null, 'GCash', ''],
  ['c03', 'Globe Fiber Biz 500Mbps', '937811682', 'Internet', 'fixed', 1475, null, 'GCash', ''],
  ['c04', 'PLDT MSME 500Mbps', '', 'Internet', 'fixed', 4763, 13, 'GCash', ''],
  ['c05', 'PLDT SME 300Mbps', '', 'Internet', 'fixed', 4500, null, 'GCash', ''],
  ['c06', 'PLDT Internet 300Mbps', '', 'Internet', 'variable', null, null, 'GCash',
    'Amount was not legible on the old sheet — confirm and set.'],
  ['c07', 'Loan 500k BPI', '', 'Loans', 'fixed', 10750, 17, 'BPI Credit Card', ''],
  ['c08', 'Loan 200k Eastwest', '6,885 x 36 months', 'Loans', 'fixed', 6809.02, 9, 'GCash', ''],
  ['c09', 'Loan 200k Unionbank', '', 'Loans', 'fixed', 6580, 10, 'GCash', ''],
  ['c10', 'Home Credit', '', 'Loans', 'fixed', 5540, null, 'BPI Credit Card', ''],
  ['c11', 'Electric', 'Meralco', 'Utilities', 'variable', 10828, null, 'GCash',
    'Varies monthly — last known ₱10,828.'],
  ['c12', 'Salary — Franz', '', 'Payroll', 'fixed', 18000, null, 'Bank Transfer', ''],
  ['c13', 'Salary — Jepjep', '', 'Payroll', 'fixed', 16000, null, 'Bank Transfer', ''],
  ['c14', 'Gas — Petron', '', 'Fuel', 'variable', 2291.84, null, 'Cash',
    'Varies monthly — last known ₱2,291.84.'],
  ['c15', 'Additional Expenses — Shopee', '', 'Supplies', 'variable', 15000, null, 'GCash',
    'Varies monthly — last known ₱15,000.'],
  ['c16', 'Samsung Phone', '', 'Equipment', 'fixed', 13000, null, 'GCash',
    'Confirm amount and schedule — old sheet was ambiguous here.'],
  ['c17', 'FOC 2-core Comlink', '', 'Equipment', 'variable', 3500, null, 'Cash',
    'Confirm amount and schedule — old sheet was ambiguous here.'],
  ['c18', 'FOC 2-core Orange', '', 'Equipment', 'variable', 2300, null, 'Cash',
    'Confirm amount and schedule — old sheet was ambiguous here.']
];

function initialState() {
  return {
    v: 1,
    meta: { org: 'StarLine', currency: '₱', updatedAt: null },
    groups: GROUPS.slice(),
    methods: METHODS.slice(),
    cats: CATS.map(function (c) {
      return {
        id: c[0], name: c[1], detail: c[2], group: c[3], kind: c[4],
        amount: c[5], dueDay: c[6], method: c[7], active: true, note: c[8]
      };
    }),
    months: {}
  };
}

module.exports = { initialState };
