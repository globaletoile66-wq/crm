import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { Webhook } from 'fedapay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type FedaPayEvent = {
  id?: string | number;
  name?: string;
  type?: string;
  data?: unknown;
  object?: unknown;
  [key: string]: unknown;
};

type FedaPayTransaction = {
  id?: string | number;
  status?: string;
  amount?: number | string;
  approved_at?: string | null;
  updated_at?: string | null;
  custom_metadata?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;
  merchant_reference?: string | null;
  [key: string]: unknown;
};

function getSupabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey =
    process.env.SUPABASE_SECRET_KEY ??
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL est manquante.');
  }

  if (!serviceKey) {
    throw new Error(
      'SUPABASE_SECRET_KEY ou SUPABASE_SERVICE_ROLE_KEY est manquante.'
    );
  }

  return createClient(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function getFedaPayBaseUrl() {
  const environment =
    process.env.FEDAPAY_ENV?.toLowerCase() === 'live'
      ? 'live'
      : 'sandbox';

  return environment === 'live'
    ? 'https://api.fedapay.com'
    : 'https://sandbox-api.fedapay.com';
}

function extractTransactionId(event: FedaPayEvent): string | null {
  const candidates: unknown[] = [
    event.data,
    event.object,
    event,
  ];

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') {
      continue;
    }

    const value = candidate as Record<string, unknown>;

    const directId =
      value.id ??
      value.transaction_id ??
      value.transactionId;

    if (
      typeof directId === 'string' ||
      typeof directId === 'number'
    ) {
      return String(directId);
    }

    const nestedTransaction = value.transaction;

    if (
      nestedTransaction &&
      typeof nestedTransaction === 'object'
    ) {
      const transaction = nestedTransaction as Record<
        string,
        unknown
      >;

      const nestedId =
        transaction.id ??
        transaction.transaction_id ??
        transaction.transactionId;

      if (
        typeof nestedId === 'string' ||
        typeof nestedId === 'number'
      ) {
        return String(nestedId);
      }
    }
  }

  return null;
}

async function getFedaPayTransaction(
  transactionId: string,
  secretKey: string
): Promise<FedaPayTransaction> {
  const response = await fetch(
    `${getFedaPayBaseUrl()}/v1/transactions/${encodeURIComponent(
      transactionId
    )}`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${secretKey}`,
        'Content-Type': 'application/json',
      },
      cache: 'no-store',
    }
  );

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      `FedaPay GET transaction failed (${response.status}).`
    );
  }

  return payload as FedaPayTransaction;
}

function getMetadata(
  transaction: FedaPayTransaction
): Record<string, unknown> {
  const customMetadata =
    transaction.custom_metadata &&
    typeof transaction.custom_metadata === 'object'
      ? transaction.custom_metadata
      : {};

  const metadata =
    transaction.metadata &&
    typeof transaction.metadata === 'object'
      ? transaction.metadata
      : {};

  return {
    ...metadata,
    ...customMetadata,
  };
}

function normalizeStatus(status: unknown) {
  return typeof status === 'string'
    ? status.toLowerCase()
    : '';
}

function toNumber(value: unknown): number | null {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number(value)
        : NaN;

  return Number.isFinite(number) ? number : null;
}

async function activateSubscription(
  transaction: FedaPayTransaction,
  organizationId: string,
  subscriptionId: string
) {
  const supabase = getSupabaseAdmin();

  const { data: subscription, error: subscriptionError } =
    await supabase
      .from('organization_subscriptions')
      .select(
        `
          id,
          organization_id,
          plan_id,
          status,
          started_at,
          expires_at,
          subscription_plans (
            id,
            code,
            name,
            price,
            currency,
            duration_days
          )
        `
      )
      .eq('id', subscriptionId)
      .eq('organization_id', organizationId)
      .maybeSingle();

  if (subscriptionError) {
    throw new Error(
      `Erreur lecture abonnement: ${subscriptionError.message}`
    );
  }

  if (!subscription) {
    throw new Error(
      'Abonnement introuvable pour cette organisation.'
    );
  }

  const plan = Array.isArray(subscription.subscription_plans)
    ? subscription.subscription_plans[0]
    : subscription.subscription_plans;

  if (!plan) {
    throw new Error('Plan de souscription introuvable.');
  }

  const transactionAmount = toNumber(transaction.amount);
  const planPrice = toNumber(plan.price);

  if (
    transactionAmount === null ||
    planPrice === null ||
    transactionAmount !== planPrice
  ) {
    throw new Error(
      `Montant FedaPay (${transactionAmount}) différent du prix du plan (${planPrice}).`
    );
  }

  const durationDays = Number(plan.duration_days);

  if (
    !Number.isInteger(durationDays) ||
    durationDays <= 0
  ) {
    throw new Error('Durée du plan invalide.');
  }

  const startDate = transaction.approved_at
    ? new Date(transaction.approved_at)
    : new Date();

  if (Number.isNaN(startDate.getTime())) {
    throw new Error('Date de validation FedaPay invalide.');
  }

  const expiresDate = new Date(startDate);
  expiresDate.setUTCDate(
    expiresDate.getUTCDate() + durationDays
  );

  const expiresAt = expiresDate.toISOString();

  const transactionId =
    transaction.id !== undefined
      ? String(transaction.id)
      : null;

  /*
   * Mise à jour du paiement d'abonnement.
   *
   * On cible uniquement cette organisation + cet abonnement.
   * Aucun paiement existant d'une autre organisation n'est touché.
   */
  const { error: paymentError } = await supabase
    .from('subscription_payments')
    .update({
      status: 'successful',
      paid_at: startDate.toISOString(),
      provider: 'fedapay',
      provider_reference: transactionId,
      metadata: {
        fedapay_transaction_id: transactionId,
        merchant_reference:
          transaction.merchant_reference ?? null,
        verified_by: 'fedapay_webhook',
      },
    })
    .eq('organization_id', organizationId)
    .eq('subscription_id', subscriptionId)
    .in('status', ['pending', 'successful']);

  if (paymentError) {
    throw new Error(
      `Erreur mise à jour paiement: ${paymentError.message}`
    );
  }

  /*
   * Activation de l'abonnement.
   */
  const { error: subscriptionUpdateError } =
    await supabase
      .from('organization_subscriptions')
      .update({
        status: 'active',
        started_at: startDate.toISOString(),
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq('id', subscriptionId)
      .eq('organization_id', organizationId);

  if (subscriptionUpdateError) {
    throw new Error(
      `Erreur activation abonnement: ${subscriptionUpdateError.message}`
    );
  }

  /*
   * Activation de l'organisation.
   */
  const { error: organizationError } = await supabase
    .from('organizations')
    .update({
      status: 'active',
      subscription_status: 'active',
      updated_at: new Date().toISOString(),
    })
    .eq('id', organizationId);

  if (organizationError) {
    throw new Error(
      `Erreur activation organisation: ${organizationError.message}`
    );
  }

  return {
    organizationId,
    subscriptionId,
    planCode: plan.code,
    planName: plan.name,
    expiresAt,
  };
}

async function markPaymentCanceled(
  organizationId: string,
  subscriptionId: string,
  transactionId: string | null
) {
  const supabase = getSupabaseAdmin();

  const { error } = await supabase
    .from('subscription_payments')
    .update({
      status: 'cancelled',
      provider: 'fedapay',
      provider_reference: transactionId,
      metadata: {
        fedapay_transaction_id: transactionId,
        verified_by: 'fedapay_webhook',
      },
    })
    .eq('organization_id', organizationId)
    .eq('subscription_id', subscriptionId)
    .eq('status', 'pending');

  if (error) {
    throw new Error(
      `Erreur mise à jour paiement annulé: ${error.message}`
    );
  }
}

export async function POST(request: NextRequest) {
  const endpointSecret =
    process.env.FEDAPAY_WEBHOOK_SECRET;

  const fedapaySecret =
    process.env.FEDAPAY_SECRET_KEY;

  if (!endpointSecret) {
    console.error(
      '[FedaPay Webhook] FEDAPAY_WEBHOOK_SECRET manquante.'
    );

    return NextResponse.json(
      {
        success: false,
        error: 'Webhook secret non configuré.',
      },
      { status: 500 }
    );
  }

  if (!fedapaySecret) {
    console.error(
      '[FedaPay Webhook] FEDAPAY_SECRET_KEY manquante.'
    );

    return NextResponse.json(
      {
        success: false,
        error: 'Clé secrète FedaPay non configurée.',
      },
      { status: 500 }
    );
  }

  const rawBody = await request.text();

  const signature = request.headers.get(
    'x-fedapay-signature'
  );

  if (!signature) {
    return NextResponse.json(
      {
        success: false,
        error: 'Signature FedaPay absente.',
      },
      { status: 400 }
    );
  }

  let event: FedaPayEvent;

  try {
    event = Webhook.constructEvent(
      rawBody,
      signature,
      endpointSecret
    ) as FedaPayEvent;
  } catch (error) {
    console.error(
      '[FedaPay Webhook] Signature invalide:',
      error
    );

    return NextResponse.json(
      {
        success: false,
        error: 'Signature webhook invalide.',
      },
      { status: 400 }
    );
  }

  const eventName =
    typeof event.name === 'string'
      ? event.name
      : typeof event.type === 'string'
        ? event.type
        : '';

  /*
   * Les événements non liés aux transactions ne nécessitent
   * aucune modification de notre base.
   */
  if (
    ![
      'transaction.created',
      'transaction.approved',
      'transaction.canceled',
      'transaction.declined',
      'transaction.refunded',
    ].includes(eventName)
  ) {
    return NextResponse.json({
      success: true,
      received: true,
      ignored: true,
      event: eventName,
    });
  }

  const transactionId =
    extractTransactionId(event);

  if (!transactionId) {
    console.error(
      '[FedaPay Webhook] ID transaction introuvable.',
      event
    );

    return NextResponse.json(
      {
        success: false,
        error: 'ID transaction introuvable.',
      },
      { status: 400 }
    );
  }

  try {
    /*
     * IMPORTANT :
     * Nous ne faisons jamais confiance uniquement aux données
     * reçues dans le webhook.
     *
     * Nous demandons directement à FedaPay l'état réel
     * de la transaction.
     */
    const transaction =
      await getFedaPayTransaction(
        transactionId,
        fedapaySecret
      );

    const metadata = getMetadata(transaction);

    const organizationId =
      typeof metadata.organization_id === 'string'
        ? metadata.organization_id
        : null;

    const subscriptionId =
      typeof metadata.subscription_id === 'string'
        ? metadata.subscription_id
        : null;

    if (!organizationId || !subscriptionId) {
      console.error(
        '[FedaPay Webhook] Metadata JDV CRM manquantes.',
        {
          transactionId,
          metadata,
        }
      );

      return NextResponse.json(
        {
          success: false,
          error:
            'organization_id ou subscription_id absent des metadata.',
        },
        { status: 400 }
      );
    }

    const transactionStatus =
      normalizeStatus(transaction.status);

    /*
     * La décision finale vient du statut retourné
     * directement par FedaPay.
     */
    if (transactionStatus === 'approved') {
      const result =
        await activateSubscription(
          transaction,
          organizationId,
          subscriptionId
        );

      return NextResponse.json({
        success: true,
        received: true,
        processed: true,
        event: eventName,
        transactionId,
        status: transactionStatus,
        ...result,
      });
    }

    if (
      transactionStatus === 'canceled' ||
      transactionStatus === 'cancelled' ||
      transactionStatus === 'declined' ||
      transactionStatus === 'refunded'
    ) {
      await markPaymentCanceled(
        organizationId,
        subscriptionId,
        transactionId
      );

      return NextResponse.json({
        success: true,
        received: true,
        processed: true,
        event: eventName,
        transactionId,
        status: transactionStatus,
      });
    }

    /*
     * pending ou autre état intermédiaire :
     * on ne touche pas à l'abonnement.
     */
    return NextResponse.json({
      success: true,
      received: true,
      processed: false,
      event: eventName,
      transactionId,
      status: transactionStatus || 'unknown',
    });
  } catch (error) {
    console.error(
      '[FedaPay Webhook] Erreur traitement:',
      error
    );

    /*
     * 500 est volontaire ici :
     * FedaPay pourra effectuer une nouvelle tentative.
     */
    return NextResponse.json(
      {
        success: false,
        received: false,
        error:
          error instanceof Error
            ? error.message
            : 'Erreur interne webhook.',
      },
      { status: 500 }
    );
  }
}
