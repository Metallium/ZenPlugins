import _ from "lodash";
import {asCashTransfer, formatComment} from "../../common/converters";
import {mergeTransfers} from "../../common/mergeTransfers";

const calculateAccountId = (card) => String(card.clientObject.id);

export function toZenmoneyAccount(card) {
    // card.clientObject.type === 5 for credit card (limits source unknown, thus non-specified)
    // card.clientObject.type === 6 for debit card
    return {
        id: calculateAccountId(card),
        title: card.clientObject.customSynonym || card.clientObject.defaultSynonym,
        type: "ccard",
        syncID: [card.clientObject.cardMaskedNumber.slice(-4)],
        instrument: card.clientObject.currIso,
        balance: card.balance.available,
    };
}

const knownTransactionTypes = ["Retail", "ATM", "CH Debit", "CH Payment", "Cash"];

const normalizeSpaces = (text) => _.compact(text.split(" ")).join(" ");

function parseTransDetails(transDetails) {
    const type = knownTransactionTypes.find((type) => transDetails.startsWith(type + " "));
    if (type) {
        return {type, payee: normalizeSpaces(transDetails.slice(type.length)), comment: null};
    } else {
        return {type: null, payee: null, comment: normalizeSpaces(transDetails)};
    }
}

const extractRegularTransactionAmount = ({accountCurrency, regularTransaction}) => {
    if (accountCurrency === regularTransaction.transCurrIso) {
        return regularTransaction.accountAmount;
    }
    if (regularTransaction.amount === 0) {
        if (regularTransaction.feeAmount !== 0) {
            return regularTransaction.feeAmount;
        }
        console.error({accountCurrency, regularTransaction});
        throw new Error("Cannot handle corrupted transaction amounts");
    }
    return Math.sign(regularTransaction.accountAmount) * Math.abs(regularTransaction.amount);
};

export function chooseDistinctCards(cardsBodyResult) {
    const cardsToEvict = _.toPairs(
        _.groupBy(cardsBodyResult, (x) => x.clientObject.cardContractNumber)
    ).reduce((idsToEvict, [cardContractNumber, cards]) => idsToEvict.concat(_.sortBy(cards, [
        (x) => x.clientObject.cardStatus === 1 ? 0 : 1,
        (x) => x.clientObject.defaultSynonym,
    ]).slice(1)), []);
    return cardsBodyResult.filter((card) => !cardsToEvict.includes(card));
}

const convertApiTransactionToReadableTransaction = (apiTransaction) => {
    const accountCurrency = apiTransaction.card.clientObject.currIso;
    if (apiTransaction.type === "abortedTransaction") {
        const abortedTransaction = apiTransaction.payload;
        const details = parseTransDetails(abortedTransaction.transDetails);
        const sign = Math.sign(-abortedTransaction.transAmount);
        const posted = {amount: sign * Math.abs(abortedTransaction.amount), instrument: accountCurrency};
        const origin = abortedTransaction.transCurrIso === accountCurrency
            ? null
            : {
                amount: -abortedTransaction.transAmount,
                instrument: abortedTransaction.transCurrIso,
            };
        return {
            type: "transaction",
            id: null,
            account: {id: calculateAccountId(apiTransaction.card)},
            date: new Date(abortedTransaction.transDate),
            hold: true,
            posted,
            origin,
            payee: details.payee,
            mcc: null,
            location: null,
            comment: _.compact([details.comment, formatComment({posted, origin})]).join("\n") || null,
        };
    }
    if (apiTransaction.type === "regularTransaction") {
        const regularTransaction = apiTransaction.payload;
        const details = parseTransDetails(regularTransaction.transDetails);
        const amount = regularTransaction.accountAmount;
        const posted = {amount, instrument: accountCurrency};
        const origin = regularTransaction.transCurrIso === accountCurrency
            ? null
            : {
                amount: extractRegularTransactionAmount({accountCurrency, regularTransaction}),
                instrument: regularTransaction.transCurrIso,
            };
        return {
            type: "transaction",
            id: null,
            account: {id: calculateAccountId(apiTransaction.card)},
            date: new Date(regularTransaction.transDate),
            hold: false,
            posted,
            origin,
            payee: details.payee,
            mcc: null,
            location: null,
            comment: _.compact([details.comment, formatComment({posted, origin})]).join("\n") || null,
        };
    }
    throw new Error(`apiTransaction.type "${apiTransaction.type}" not implemented`);
};

export function convertApiCardsToReadableTransactions({cardsBodyResultWithoutDuplicates, cardDescBodyResult}) {
    const cardDescByIdLookup = _.keyBy(cardDescBodyResult, (x) => x.id);
    const abortedContracts = _.flatMap(
        cardsBodyResultWithoutDuplicates,
        (card) => cardDescByIdLookup[card.clientObject.id].contract.abortedContractList.map((abortedContract) => ({
            abortedContract,
            card,
        })),
    );
    const abortedTransactions = _.flatMap(
        abortedContracts,
        ({abortedContract, card}) => abortedContract.abortedTransactionList.reverse()
            .map((abortedTransaction) => ({type: "abortedTransaction", payload: abortedTransaction, card})),
    );
    const transCards = _.flatMap(
        cardsBodyResultWithoutDuplicates,
        (card) => cardDescByIdLookup[card.clientObject.id].contract.account.transCardList.map((transCard) => ({
            transCard,
            card,
        })),
    );
    const regularTransactions = _.flatMap(
        transCards,
        ({transCard, card}) => transCard.transactionList.reverse()
            .map((regularTransaction) => ({type: "regularTransaction", payload: regularTransaction, card})),
    );
    const items = abortedTransactions.concat(regularTransactions)
        .map((apiTransaction) => {
            const readableTransaction = convertApiTransactionToReadableTransaction(apiTransaction);
            if (["ATM", "Cash"].includes(parseTransDetails(apiTransaction.payload.transDetails).type)) {
                return {apiTransaction, readableTransaction: asCashTransfer(readableTransaction)};
            }
            return {apiTransaction, readableTransaction};
        });
    return mergeTransfers({
        items: _.sortBy(items, ({readableTransaction}) => readableTransaction.date),
        selectReadableTransaction: (item) => item.readableTransaction,
        isTransferItem: (item) =>
            item.apiTransaction.payload.transDetails.includes("P2P SDBO") ||
            item.apiTransaction.payload.transDetails.includes("P2P_SDBO"),
        makeGroupKey: (item) => {
            const {amount, instrument} = item.readableTransaction.origin || item.readableTransaction.posted;
            return `${Math.abs(amount)} ${instrument} @ ${item.readableTransaction.date} ${item.apiTransaction.payload.transTime}`;
        },
        selectTransactionId: (item) => {
            if (item.readableTransaction.type === "transfer") { // e.g. Cash, ATM
                return null;
            }
            const {amount, instrument} = item.readableTransaction.origin || item.readableTransaction.posted;
            const sign = item.readableTransaction.posted.amount >= 0 ? "+" : "-";
            return `${Math.abs(amount)} ${instrument} @ ${item.readableTransaction.date} ${item.apiTransaction.payload.transTime} ${sign}`;
        },
    });
}