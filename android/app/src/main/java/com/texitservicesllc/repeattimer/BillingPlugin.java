package com.texitservicesllc.repeattimer;

import android.content.pm.ApplicationInfo;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * One-time "unlock_full" purchase via Google Play Billing.
 * JS bridge: window.Capacitor.Plugins.Billing
 */
@CapacitorPlugin(name = "Billing")
public class BillingPlugin extends Plugin implements PurchasesUpdatedListener {
    static final String PRODUCT_ID = "unlock_full";

    private BillingClient client;
    private ProductDetails product;
    private PluginCall pendingPurchase;

    @Override
    public void load() {
        client = BillingClient.newBuilder(getContext())
                .setListener(this)
                .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
                .enableAutoServiceReconnection()
                .build();
    }

    private boolean isDebuggable() {
        return (getContext().getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
    }

    private interface Ready { void run(); }

    private void withClient(PluginCall call, Ready ready) {
        if (client.isReady()) { ready.run(); return; }
        client.startConnection(new BillingClientStateListener() {
            @Override
            public void onBillingSetupFinished(BillingResult r) {
                if (r.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                    ready.run();
                } else {
                    JSObject o = base();
                    o.put("available", false);
                    o.put("error", "Google Play billing unavailable (" + r.getResponseCode() + ")");
                    call.resolve(o);
                }
            }

            @Override
            public void onBillingServiceDisconnected() { /* auto-reconnect enabled */ }
        });
    }

    private JSObject base() {
        JSObject o = new JSObject();
        o.put("debug", isDebuggable());
        return o;
    }

    // ---------- status / restore ----------

    /** Resolves { available, known, purchased, price, debug }. */
    @PluginMethod
    public void getStatus(PluginCall call) {
        withClient(call, () -> queryOwned((known, owned) -> loadProduct(() -> {
            JSObject o = base();
            o.put("available", true);
            o.put("known", known);
            o.put("purchased", owned);
            String price = priceOf(product);
            if (price != null) o.put("price", price);
            call.resolve(o);
        })));
    }

    private interface OwnedCallback { void done(boolean known, boolean owned); }

    private void queryOwned(OwnedCallback cb) {
        QueryPurchasesParams params = QueryPurchasesParams.newBuilder()
                .setProductType(BillingClient.ProductType.INAPP).build();
        client.queryPurchasesAsync(params, (r, purchases) -> {
            if (r.getResponseCode() != BillingClient.BillingResponseCode.OK) { cb.done(false, false); return; }
            boolean owned = false;
            for (Purchase p : purchases) owned |= handle(p);
            cb.done(true, owned);
        });
    }

    /** Acknowledges if needed; returns true if this purchase grants the unlock. */
    private boolean handle(Purchase p) {
        if (!p.getProducts().contains(PRODUCT_ID)) return false;
        if (p.getPurchaseState() != Purchase.PurchaseState.PURCHASED) return false;
        if (!p.isAcknowledged()) {
            // Must acknowledge within 3 days or Google refunds the purchase.
            client.acknowledgePurchase(
                    AcknowledgePurchaseParams.newBuilder().setPurchaseToken(p.getPurchaseToken()).build(),
                    r -> { });
        }
        return true;
    }

    private void loadProduct(Ready then) {
        if (product != null) { then.run(); return; }
        QueryProductDetailsParams params = QueryProductDetailsParams.newBuilder()
                .setProductList(Collections.singletonList(
                        QueryProductDetailsParams.Product.newBuilder()
                                .setProductId(PRODUCT_ID)
                                .setProductType(BillingClient.ProductType.INAPP)
                                .build()))
                .build();
        client.queryProductDetailsAsync(params, (r, result) -> {
            if (r.getResponseCode() == BillingClient.BillingResponseCode.OK && result != null) {
                List<ProductDetails> list = result.getProductDetailsList();
                if (list != null && !list.isEmpty()) product = list.get(0);
            }
            then.run();
        });
    }

    private static String priceOf(ProductDetails pd) {
        if (pd == null) return null;
        ProductDetails.OneTimePurchaseOfferDetails d = pd.getOneTimePurchaseOfferDetails();
        return d != null ? d.getFormattedPrice() : null;
    }

    // ---------- purchase ----------

    /** Resolves { purchased, pending?, cancelled?, error? }. */
    @PluginMethod
    public void purchase(PluginCall call) {
        withClient(call, () -> loadProduct(() -> {
            if (product == null) {
                JSObject o = new JSObject();
                o.put("purchased", false);
                o.put("error", "Product not available yet. (Is the app installed from a Play testing track?)");
                call.resolve(o);
                return;
            }
            BillingFlowParams.ProductDetailsParams.Builder pdp =
                    BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(product);
            List<ProductDetails.OneTimePurchaseOfferDetails> offers = product.getOneTimePurchaseOfferDetailsList();
            if (offers != null && !offers.isEmpty() && offers.get(0).getOfferToken() != null) {
                pdp.setOfferToken(offers.get(0).getOfferToken());
            }
            List<BillingFlowParams.ProductDetailsParams> list = new ArrayList<>();
            list.add(pdp.build());
            BillingFlowParams flow = BillingFlowParams.newBuilder().setProductDetailsParamsList(list).build();

            pendingPurchase = call;
            getActivity().runOnUiThread(() -> {
                BillingResult r = client.launchBillingFlow(getActivity(), flow);
                if (r.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    finishPurchase(false, false, false, "Could not start purchase (" + r.getResponseCode() + ")");
                }
            });
        }));
    }

    @Override
    public void onPurchasesUpdated(BillingResult r, List<Purchase> purchases) {
        int code = r.getResponseCode();
        if (code == BillingClient.BillingResponseCode.OK && purchases != null) {
            boolean owned = false, pending = false;
            for (Purchase p : purchases) {
                owned |= handle(p);
                if (p.getProducts().contains(PRODUCT_ID) && p.getPurchaseState() == Purchase.PurchaseState.PENDING) pending = true;
            }
            finishPurchase(owned, pending && !owned, false, null);
        } else if (code == BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED) {
            finishPurchase(true, false, false, null);
        } else if (code == BillingClient.BillingResponseCode.USER_CANCELED) {
            finishPurchase(false, false, true, null);
        } else {
            finishPurchase(false, false, false, "Purchase failed (" + code + ")");
        }
    }

    private void finishPurchase(boolean purchased, boolean pending, boolean cancelled, String error) {
        PluginCall call = pendingPurchase;
        pendingPurchase = null;
        if (call == null) return;
        JSObject o = new JSObject();
        o.put("purchased", purchased);
        if (pending) o.put("pending", true);
        if (cancelled) o.put("cancelled", true);
        if (error != null) o.put("error", error);
        call.resolve(o);
    }
}
