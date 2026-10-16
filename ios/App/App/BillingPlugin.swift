import Foundation
import Capacitor
import StoreKit

/// StoreKit 2 one-time unlock, same JS API as the Android Play Billing plugin
/// (window.Capacitor.Plugins.Billing), plus Apple's recommended free trial item:
/// a $0 non-consumable "trial_7day" whose purchase date starts the 7-day trial.
@objc(BillingPlugin)
public class BillingPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "BillingPlugin"
    public let jsName = "Billing"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "purchase", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startTrial", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "restore", returnType: CAPPluginReturnPromise),
    ]

    static let unlockId = "unlock_full"
    static let trialId = "trial_7day"

    private var updates: Task<Void, Never>?

    private var isDebug: Bool {
        #if DEBUG
        return true
        #else
        return false
        #endif
    }

    override public func load() {
        // Finish transactions that complete outside a purchase call (Ask to Buy, interrupted purchases).
        updates = Task.detached {
            for await result in Transaction.updates {
                if case .verified(let t) = result { await t.finish() }
            }
        }
    }

    deinit { updates?.cancel() }

    // MARK: - JS API

    /// Resolves { available, known, purchased, trialRequired, trialStart?, price?, debug }.
    @objc func getStatus(_ call: CAPPluginCall) {
        Task { call.resolve(await self.status()) }
    }

    @objc func restore(_ call: CAPPluginCall) {
        Task {
            try? await AppStore.sync()
            call.resolve(await self.status())
        }
    }

    /// Resolves { purchased, pending?, cancelled?, error? }.
    @objc func purchase(_ call: CAPPluginCall) {
        Task {
            let r = await self.buy(BillingPlugin.unlockId)
            var o: [String: Any] = ["purchased": r.ok]
            if r.pending { o["pending"] = true }
            if r.cancelled { o["cancelled"] = true }
            if let e = r.error { o["error"] = e }
            call.resolve(o)
        }
    }

    /// Resolves { started, trialStart?, cancelled?, error? }.
    @objc func startTrial(_ call: CAPPluginCall) {
        Task {
            let r = await self.buy(BillingPlugin.trialId)
            var o: [String: Any] = ["started": r.ok]
            if r.ok, let ts = await self.trialStart() { o["trialStart"] = ts }
            if r.cancelled { o["cancelled"] = true }
            if let e = r.error { o["error"] = e }
            call.resolve(o)
        }
    }

    // MARK: - StoreKit

    private func status() async -> [String: Any] {
        var purchased = false
        for await result in Transaction.currentEntitlements {
            if case .verified(let t) = result, t.productID == BillingPlugin.unlockId, t.revocationDate == nil {
                purchased = true
            }
        }
        var o: [String: Any] = [
            "available": true, "known": true, "purchased": purchased,
            "trialRequired": true, "debug": isDebug,
        ]
        if let ts = await trialStart() { o["trialStart"] = ts }
        if let p = try? await Product.products(for: [BillingPlugin.unlockId]).first {
            o["price"] = p.displayPrice
        }
        return o
    }

    /// When the free trial item was first claimed (ms since epoch), if ever.
    private func trialStart() async -> Double? {
        if let result = await Transaction.latest(for: BillingPlugin.trialId),
           case .verified(let t) = result {
            return t.originalPurchaseDate.timeIntervalSince1970 * 1000
        }
        return nil
    }

    private struct BuyResult { var ok = false; var pending = false; var cancelled = false; var error: String? }

    private func buy(_ productId: String) async -> BuyResult {
        var r = BuyResult()
        do {
            guard let product = try await Product.products(for: [productId]).first else {
                r.error = "Product not available: \(productId)"
                return r
            }
            switch try await product.purchase() {
            case .success(let verification):
                if case .verified(let t) = verification {
                    await t.finish()
                    r.ok = true
                } else {
                    r.error = "Purchase could not be verified."
                }
            case .pending:
                r.pending = true
            case .userCancelled:
                r.cancelled = true
            @unknown default:
                r.error = "Purchase did not complete."
            }
        } catch {
            r.error = error.localizedDescription
        }
        return r
    }
}
